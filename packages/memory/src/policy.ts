import type { MemWal, RecallMemory } from "@mysten-incubation/memwal";
import { type MemoryRecord, parseMemoryText } from "./format.ts";
import { type RateLimiter, runLimited } from "./limiter.ts";

/** Cosine-distance bands from memwal/SKILL.md. Lower is more similar. */
export const DISTANCE = { duplicate: 0.25, related: 0.55, weak: 0.7 } as const;

export interface RecalledMemory extends RecallMemory {
  parsed: MemoryRecord | null;
}

export interface RecallRelevantOptions {
  query: string;
  namespace: string;
  limit?: number;
  maxDistance?: number;
  limiter?: RateLimiter;
}

/**
 * Measured on mainnet 2026-09-21: clearly relevant matches land between 0.45
 * and 0.78, so the SDK's "0.7 and above is unrelated" guidance is too tight for
 * question-shaped queries. Missing a real memory is worse than injecting one
 * weak line, because the untrusted-data framing already tells the model to
 * ignore what does not fit.
 */
export const DEFAULT_MAX_DISTANCE = 0.8;

/**
 * How hard to push back on a dropped recall. Measured across two eval runs: the
 * drop rate rises with concurrency and three attempts at one and two seconds was
 * not always enough, so this backs off further and tries once more.
 */
const RECALL_ATTEMPTS = 4;
const RECALL_RETRY_BASE_MS = 1_500;

/**
 * Order recalled memories newest first, so a fact that has been superseded
 * never leads.
 *
 * Selection stays by distance — that decides which memories are relevant at
 * all. This decides only the order the model reads them in, and it pairs with
 * the conflict rule in the system prompt: the rule is worth little if the stale
 * memory is still the first thing in the block.
 *
 * It is needed because a contradiction is not a near-duplicate.
 * `rememberWithDedupe` collapses anything under `DISTANCE.duplicate`, but "I
 * switched to bun" sits in the related band against "I only use pnpm", so both
 * are stored and both are recalled — and measured on production, the stale one
 * ranked *higher* (docs/SCOPE-RESEARCH.md §1).
 *
 * The key is the relayer's `created_at`, the write time to the second. The date
 * inside our own text format is only a day, which cannot order a correction
 * made ten minutes after the fact it corrects. It is the fallback for relayers
 * old enough to omit `created_at`, and undated memories sort last: an undated
 * line predates the dated format, so it must never outrank a dated correction.
 *
 * Not `recall({ sort: "recent" })`. That reorders on the relayer and then
 * truncates, so it changes *which* memories come back, and would let a recent
 * vague line push out an older exact match.
 */
export function writtenAt(m: RecalledMemory): string {
  return m.created_at ?? m.parsed?.date ?? "";
}

export function orderNewestFirst<T extends RecalledMemory>(memories: T[]): T[] {
  return [...memories].sort((a, b) => {
    const ta = writtenAt(a);
    const tb = writtenAt(b);
    if (ta !== tb) return tb.localeCompare(ta);
    return a.distance - b.distance;
  });
}

export async function recallRelevant(
  client: MemWal,
  {
    query,
    namespace,
    limit = 6,
    maxDistance = DEFAULT_MAX_DISTANCE,
    limiter,
  }: RecallRelevantOptions,
): Promise<RecalledMemory[]> {
  const call = () => client.recall({ query, namespace, limit, maxDistance });

  // The relayer intermittently returns `{results: [], total: 0, dropped_count: N}`
  // for a namespace that definitely holds matches: it found N candidates and
  // discarded every one, with no error. Taking that at face value makes the bot
  // silently forget, so retry before believing an empty result that had
  // candidates. Observed 2026-09-21, see docs/SPIKES.md §5.
  for (let attempt = 1; attempt <= RECALL_ATTEMPTS; attempt++) {
    const res = limiter ? await runLimited(limiter, call) : await call();
    // Typed by the SDK: matches the relayer found but could not download or decrypt.
    const dropped = res.dropped_count ?? 0;
    if (res.results.length > 0 || dropped === 0) {
      return res.results
        .filter((m) => m.distance < maxDistance)
        .map((m) => ({ ...m, parsed: parseMemoryText(m.text) }));
    }
    console.warn(
      `[memory] recall in ${namespace} dropped all ${dropped} candidates (attempt ${attempt}/${RECALL_ATTEMPTS})`,
    );
    if (attempt < RECALL_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, RECALL_RETRY_BASE_MS * 2 ** (attempt - 1)));
    }
  }
  console.error(
    `[memory] recall in ${namespace} gave up after ${RECALL_ATTEMPTS} dropped attempts`,
  );
  return [];
}

export type RememberOutcome =
  | { status: "accepted"; jobId: string; settled: Promise<SettledWrite> }
  | { status: "duplicate"; blobId: string; distance: number; existing: string };

export interface SettledWrite {
  status: "stored" | "failed";
  blobId: string | null;
  error?: string;
  /** How many submissions it took. More than one means the relayer dropped a job. */
  attempts: number;
}

/** A dropped job is resubmitted this many times before the write is called lost. */
const WRITE_ATTEMPTS = 3;
const WRITE_RETRY_BASE_MS = 5_000;

export interface RememberOptions {
  text: string;
  namespace: string;
  limiter?: RateLimiter;
  /** Blob ids that never count as a duplicate: the ones the person hid. */
  ignore?: ReadonlySet<string>;
  /** How long the background settle may take before giving up. */
  timeoutMs?: number;
  /**
   * `false` skips the semantic duplicate check. Structured records (a pick, a payday, an approval)
   * are distinct events even when their text differs only by an id, and the check, which costs a
   * recall per write, discarded them as "already known" (ADR-0063). Default `true`.
   */
  dedupe?: boolean;
}

/**
 * Dedupe, then accept the write and return immediately.
 *
 * `rememberAndWait` takes about 24 s on mainnet (measured 2026-09-21), which is
 * far too long to hold a chat reply. The relayer accepts the job in well under
 * a second and mints the blob asynchronously, so the caller gets a job id now
 * and a `settled` promise that resolves with the blob id later.
 */
export async function rememberWithDedupe(
  client: MemWal,
  { text, namespace, limiter, timeoutMs = 120_000, ignore, dedupe = true }: RememberOptions,
): Promise<RememberOutcome> {
  /**
   * Dedupe is an optimisation, not a precondition. In production the relayer
   * answered this recall with "temporarily cannot verify credentials (upstream
   * unavailable)", the error propagated, and the bot told the user it could not
   * remember anything: a duplicate check took the whole feature down. If the
   * check cannot run, write anyway. A duplicate memory is a far smaller problem
   * than a lost one.
   */
  /**
   * A correction is never a duplicate of the fact it corrects.
   *
   * Semantic distance cannot see negation, and a correction usually names the
   * value it replaces: "I moved to Neovim; I no longer use VS Code" measured
   * 0.243 from "I use VS Code with vim bindings", and "the deadline moved to
   * October 10, not October 3" measured 0.221 from "ship by October 3". Both
   * are under `DISTANCE.duplicate`, so both were discarded as already known —
   * the user corrected hippo, was told "already knew", and nothing changed
   * (packages/memory/scripts/spike-corrections.ts). So an incoming correction
   * is only deduplicated against earlier corrections, which is the one case
   * where "the same thing again" really is a repeat.
   */
  const incoming = parseMemoryText(text)?.type;
  let dup: RecalledMemory | undefined;
  if (dedupe)
    try {
      const near = await recallRelevant(client, {
        query: text,
        namespace,
        limit: 3,
        maxDistance: DISTANCE.duplicate,
        limiter,
      });
      dup = near.find(
        (m) =>
          !ignore?.has(m.blob_id) && (incoming !== "correction" || m.parsed?.type === "correction"),
      );
    } catch (err) {
      console.warn(
        `[memory] dedupe check failed in ${namespace}, writing anyway: ${err instanceof Error ? err.message : err}`,
      );
    }
  if (dup) {
    return { status: "duplicate", blobId: dup.blob_id, distance: dup.distance, existing: dup.text };
  }

  const accept = () => client.remember(text, namespace);
  const accepted = limiter ? await runLimited(limiter, accept) : await accept();

  const settled: Promise<SettledWrite> = (async () => {
    let lastError = "";
    // The relayer's own Sui RPC gets throttled during SEAL encryption and the
    // job dies with "seal encrypt failed … RpcError: Too Many Requests". The
    // memory is gone, after the user was already told it was saved, so a failed
    // job is resubmitted rather than reported as lost. Observed 2026-09-21.
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
      let jobId: string | null = accepted.job_id;
      if (attempt > 1) {
        try {
          const again = limiter ? await runLimited(limiter, accept) : await accept();
          jobId = again.job_id;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          jobId = null;
        }
      }
      if (!jobId) break;

      try {
        const id = jobId;
        const wait = () => client.waitForRememberJob(id, { timeoutMs, pollIntervalMs: 2_000 });
        // waitForRememberJob resolves with the stored memory and throws when
        // the job failed or timed out.
        const done = limiter ? await runLimited(limiter, wait) : await wait();
        if (done.blob_id) {
          return { status: "stored" as const, blobId: done.blob_id, attempts: attempt };
        }
        lastError = "job completed without a blob id";
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      if (attempt < WRITE_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, WRITE_RETRY_BASE_MS * 2 ** (attempt - 1)));
      }
    }
    return { status: "failed" as const, blobId: null, error: lastError, attempts: WRITE_ATTEMPTS };
  })();
  // A rejection is impossible above, but never leave an unobserved promise.
  settled.catch(() => {});

  return { status: "accepted", jobId: accepted.job_id, settled };
}

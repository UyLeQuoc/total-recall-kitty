/**
 * MemoryPort is what the agent core talks to. It hides guest vs owned,
 * namespaces, dedupe, rate limiting and text formatting, so channel adapters
 * and the LLM loop never touch MemWal directly.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createClient, type MemoryScope } from "./client.ts";
import { buildMemoryText, type MemoryType, replacesBlobId } from "./format.ts";
import { limiterFor } from "./limiter.ts";
import { type RecalledMemory, recallRelevant, rememberWithDedupe } from "./policy.ts";
import { redactCredentials } from "./redact.ts";

export interface RememberInput {
  type: MemoryType;
  text: string;
  channel?: string;
  knownHashes?: ReadonlySet<string>;
  replaces?: string;
}

/** What the LLM sees. Deliberately small and free of internal ids. */
export interface RememberResult extends Record<string, unknown> {
  saved: boolean;
  note: string;
  redacted: string[];
  indexId?: string;
  blobId?: string;
}

export interface RecallInput {
  query: string;
  limit?: number;
  maxDistance?: number;
}

export interface MemoryPort {
  readonly scope: MemoryScope;
  remember(input: RememberInput): Promise<RememberResult>;
  recall(input: RecallInput): Promise<RecalledMemory[]>;
  /** Resolves once every background write started by this port has settled. */
  flush(): Promise<void>;
}

export interface WriteEvent {
  scope: MemoryScope;
  type: MemoryType;
  /** Present once the blob exists, or for a duplicate (the blob it matched). */
  blobId: string | null;
  jobId: string | null;
  textSha256: string;
  channel: string;
  /**
   * `accepted` fires immediately and should be persisted straight away: a
   * deploy during the ~25 s write window must not lose a memory the user was
   * already told about. `stored` or `failed` follows for the same job id.
   */
  outcome: "accepted" | "stored" | "failed" | "duplicate";
  error?: string;
}

export interface CreatePortOptions {
  scope: MemoryScope;
  /** Handle written into the [by:@handle] tag. */
  by: string;
  channel: string;
  onWrite?: (e: WriteEvent) => undefined | Promise<string | undefined>;
  /**
   * Extra scopes to read from and never write to.
   *
   * This is what stops `/connect` erasing someone. Guest memories live in
   * hippo's own account under `hippo-guest:<personId>`; taking ownership moves
   * writes to the user's own account under `hippo`, a different account and a
   * different namespace. Without reading the old scope too, the moment a person
   * takes ownership of their memory is the moment it all disappears.
   */
  alsoRead?: MemoryScope[];
  /**
   * Blob ids the person asked hippo to stop using. Nothing on Walrus can be
   * deleted or edited, so hiding is ours: these never come back from recall,
   * and never count as a duplicate either — otherwise restating a hidden fact
   * would be answered "already known" and stored nowhere hippo can see.
   */
  hidden?: ReadonlySet<string>;
  /** `false` writes without the semantic duplicate check (structured records, ADR-0063). */
  dedupe?: boolean;
}

export function createMemoryPort({
  scope,
  by,
  channel,
  onWrite,
  alsoRead = [],
  hidden = new Set(),
  dedupe = true,
}: CreatePortOptions): MemoryPort {
  const client = createClient(scope);
  const limiter = limiterFor(scope.key);
  const pending = new Set<Promise<unknown>>();
  /** Read-only companions, each with its own client and its own key's limiter. */
  const secondary = alsoRead.map((s) => ({
    scope: s,
    client: createClient(s),
    limiter: limiterFor(s.key),
  }));

  const track = (p: Promise<unknown>) => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };

  return {
    scope,

    async remember(input) {
      const { text, removed } = redactCredentials(input.text);
      const line = buildMemoryText({
        type: input.type,
        by,
        channel: input.channel,
        text,
        replaces: replacesBlobId(input.replaces) ?? undefined,
      });
      const sha = bytesToHex(sha256(new TextEncoder().encode(line)));
      if (input.knownHashes?.has(sha)) {
        return {
          saved: false,
          note: "Already in memory, nothing written. Do not tell the user it was saved again.",
          redacted: removed,
        };
      }
      const outcome = await rememberWithDedupe(client, {
        text: line,
        namespace: scope.namespace,
        limiter,
        ignore: hidden,
        dedupe,
      });

      if (outcome.status === "duplicate") {
        await onWrite?.({
          scope,
          type: input.type,
          blobId: outcome.blobId,
          jobId: null,
          textSha256: sha,
          channel,
          outcome: "duplicate",
        });
        return {
          saved: false,
          note: "Already in memory, nothing written. Do not tell the user it was saved again.",
          redacted: removed,
          ...(outcome.blobId ? { blobId: outcome.blobId } : {}),
        };
      }

      // Record the accepted job now, so the memory survives a restart or deploy
      // during the write window rather than vanishing after the user was told
      // it was saved.
      const indexId = await onWrite?.({
        scope,
        type: input.type,
        blobId: null,
        jobId: outcome.jobId,
        textSha256: sha,
        channel,
        outcome: "accepted",
      });

      // The blob id arrives ~25 s later; fill it in then.
      track(
        outcome.settled.then(async (s) => {
          if (s.status !== "stored" || !s.blobId) {
            console.error(
              `[memory] write failed in ${scope.namespace}: ${s.error ?? "no blob id"}`,
            );
          }
          await onWrite?.({
            scope,
            type: input.type,
            blobId: s.blobId,
            jobId: outcome.jobId,
            textSha256: sha,
            channel,
            outcome: s.status,
            error: s.error,
          });
        }),
      );

      return {
        saved: true,
        note: `Stored as ${input.type}. It is being written to Walrus now and is recallable within about a minute.`,
        redacted: removed,
        ...(typeof indexId === "string" ? { indexId } : {}),
      };
    },

    async recall(input) {
      const visible = (list: RecalledMemory[]) => list.filter((m) => !hidden.has(m.blob_id));
      const primary = visible(
        await recallRelevant(client, {
          ...input,
          namespace: scope.namespace,
          limiter,
        }),
      );
      if (!secondary.length) return primary;

      /**
       * Sequential, deliberately. Concurrent recalls make the relayer answer
       * with an empty result and a non-zero `dropped_count` (docs/SPIKES.md
       * §H), which is why the agent stopped issuing its own in parallel. Doing
       * it here in parallel would reintroduce exactly that.
       */
      const seen = new Map(primary.map((m) => [m.blob_id, m]));
      for (const extra of secondary) {
        try {
          const more = await recallRelevant(extra.client, {
            ...input,
            namespace: extra.scope.namespace,
            limiter: extra.limiter,
          });
          for (const m of visible(more)) if (!seen.has(m.blob_id)) seen.set(m.blob_id, m);
        } catch (err) {
          // Old memories are a bonus; failing to reach them must never cost the
          // user the ones in the account they actually own.
          console.warn("[memory] secondary recall failed", err);
        }
      }
      const merged = [...seen.values()].sort((a, b) => a.distance - b.distance);
      // Only truncate when the caller asked for a size. Defaulting to the
      // primary's length silently discarded every older memory whenever the
      // owned account happened to return fewer, which is the exact failure
      // this whole path exists to prevent.
      return input.limit ? merged.slice(0, input.limit) : merged;
    },

    async flush() {
      await Promise.allSettled([...pending]);
    },
  };
}

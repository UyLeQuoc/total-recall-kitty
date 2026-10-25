/**
 * Kitty's memory (ADR-0062): the operator's Walrus Memory account on the mainnet relayer, one
 * namespace per kind of conclusion. Every write is indexed in `kitty.memories` so a 🧠 reason can
 * link its blob, and recall goes through `@total-recall/memory`'s retrying, rate-limited port.
 */
import { randomUUID } from "node:crypto";
import {
  createMemoryPort,
  type MemoryPort,
  type MemoryType,
  parseMemoryText,
  type WriteEvent,
} from "@total-recall/memory";
import { eq } from "drizzle-orm";
import { type Db, memories } from "./db/index.ts";

export const ns = {
  /** Paydays, skips and adaptations, per member, in one namespace per pot. */
  members: (potId: string) => `kitty:pot:${potId}:members`,
  /** Approval patterns, suggested rules and rule changes. */
  norms: (potId: string) => `kitty:pot:${potId}:norms`,
};

export interface Recalled {
  blobId: string;
  text: string;
  /** The memory's own text, without our `[type] [by:] [date]` tags. */
  body: string;
  distance: number;
  createdAt?: string;
}

export interface KittyMemory {
  remember(
    namespace: string,
    kind: MemoryType,
    text: string,
  ): Promise<{ id: string; saved: boolean }>;
  recall(namespace: string, query: string, limit?: number): Promise<Recalled[]>;
  flush(): Promise<void>;
}

export interface Operator {
  key: string;
  accountId: string;
  serverUrl: string;
}

const RECALL_TIMEOUT_MS = 45_000;

export function createKittyMemory(db: Db, operator: Operator): KittyMemory {
  const ports = new Map<string, MemoryPort>();
  const portFor = (namespace: string) => {
    let port = ports.get(namespace);
    if (!port) {
      port = createMemoryPort({
        scope: { mode: "guest", ...operator, namespace },
        by: "kitty",
        channel: "kitty",
        onWrite: (e) => onWrite(db, namespace, e),
        // Each record is a distinct event (a pick, a payday, an approval), not a fact to dedupe (ADR-0063).
        dedupe: false,
      });
      ports.set(namespace, port);
    }
    return port;
  };

  return {
    async remember(namespace, kind, text) {
      const port = portFor(namespace);
      const r = await port.remember({ type: kind, text });
      const id = (r.indexId as string | undefined) ?? "";
      if (id) await db.update(memories).set({ text }).where(eq(memories.id, id));
      return { id, saved: r.saved };
    },
    async recall(namespace, query, limit = 10) {
      const port = portFor(namespace);
      const list = await Promise.race([
        port.recall({ query, limit }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Walrus Memory recall timed out")), RECALL_TIMEOUT_MS),
        ),
      ]);
      return list.map((m) => ({
        blobId: m.blob_id,
        text: m.text,
        body: parseMemoryText(m.text)?.text ?? m.text,
        distance: m.distance,
        ...(m.created_at ? { createdAt: m.created_at } : {}),
      }));
    },
    async flush() {
      await Promise.allSettled([...ports.values()].map((p) => p.flush()));
    },
  };
}

/** `accepted` is recorded at once (a restart mustn't lose a memory), `stored` fills the blob id. */
async function onWrite(db: Db, namespace: string, e: WriteEvent): Promise<string | undefined> {
  if (e.outcome === "accepted") {
    const id = randomUUID();
    await db.insert(memories).values({
      id,
      namespace,
      kind: e.type,
      text: "",
      sha256: e.textSha256,
      jobId: e.jobId,
      status: "accepted",
    });
    return id;
  }
  if (e.outcome === "duplicate") return undefined;
  if (e.jobId) {
    await db
      .update(memories)
      .set({ status: e.outcome, blobId: e.blobId, error: e.error ?? null })
      .where(eq(memories.jobId, e.jobId));
  }
  return undefined;
}

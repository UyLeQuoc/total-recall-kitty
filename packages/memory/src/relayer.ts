/**
 * Signed requests for relayer routes the SDK does not wrap:
 * /api/stats, /api/forget, /api/whoami, /v1/owners/:owner/memories, /v1/owners/:owner/agents.
 * Canonical string and headers mirror packages/sdk/src/memwal.ts#signedRequest.
 * None of these routes decrypt, so no x-seal-session header is needed.
 */
import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { MemoryScope } from "./client.ts";

export interface StatsResult {
  memory_count: number;
  storage_bytes: number;
  namespace: string;
  owner: string;
}
export interface ForgetResult {
  deleted: number;
  namespace: string;
  owner: string;
}
export interface WhoamiResult {
  account_id: string;
  owner: string;
  package_id: string;
}
export interface AgentsResult {
  agents: Array<{ label: string; sui_address: string }>;
  snapshot_version: number;
}
export interface MemoryMeta {
  memory_id: string;
  namespace_id: string;
  blob_id: string;
  created_at: string;
  updated_at: string;
  size: number;
  agent_id: string | null;
  package_id: string;
  status: "active" | "expired";
  end_epoch: number | null;
  expires_at: string | null;
  importance: number | null;
}
export interface MemoriesPage {
  memories: MemoryMeta[];
  deleted: string[];
  must_resync: boolean;
  next_cursor: string | null;
  has_more: boolean;
  snapshot_version: number;
}

export class RelayerExtras {
  private ownerPromise: Promise<string> | null = null;
  constructor(private readonly scope: Pick<MemoryScope, "key" | "accountId" | "serverUrl">) {}

  stats(namespace: string): Promise<StatsResult> {
    return this.signed<StatsResult>("POST", "/api/stats", { namespace });
  }
  forget(namespace: string): Promise<ForgetResult> {
    return this.signed<ForgetResult>("POST", "/api/forget", { namespace });
  }
  whoami(): Promise<WhoamiResult> {
    return this.signed<WhoamiResult>("GET", "/api/whoami");
  }
  async agents(): Promise<AgentsResult> {
    const owner = await this.owner();
    return this.signed<AgentsResult>("GET", `/v1/owners/${owner}/agents`);
  }
  async memories(opts: { cursor?: string; limit?: number } = {}): Promise<MemoriesPage> {
    const owner = await this.owner();
    const q = new URLSearchParams();
    if (opts.cursor) q.set("updated_after", opts.cursor);
    if (opts.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this.signed<MemoriesPage>("GET", `/v1/owners/${owner}/memories${qs ? `?${qs}` : ""}`);
  }
  /** Every memory for this owner, all pages. */
  async allMemories(): Promise<MemoryMeta[]> {
    const out: MemoryMeta[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 100; i++) {
      const page = await this.memories({ cursor, limit: 500 });
      out.push(...page.memories);
      if (!page.has_more || !page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return out;
  }

  private owner(): Promise<string> {
    this.ownerPromise ??= this.stats("default").then((s) => s.owner);
    return this.ownerPromise;
  }

  private async signed<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyStr = method === "GET" ? "" : JSON.stringify(body ?? {});
    const bodySha = bytesToHex(sha256(new TextEncoder().encode(bodyStr)));
    const nonce = crypto.randomUUID();
    const message = `${timestamp}.${method}.${path}.${bodySha}.${nonce}.${this.scope.accountId}`;
    const priv = hexToBytes(this.scope.key);
    const sig = await ed.signAsync(new TextEncoder().encode(message), priv);
    const pub = await ed.getPublicKeyAsync(priv);
    const res = await fetch(`${this.scope.serverUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-public-key": bytesToHex(pub),
        "x-signature": bytesToHex(sig),
        "x-timestamp": timestamp,
        "x-nonce": nonce,
        "x-account-id": this.scope.accountId,
      },
      body: method === "GET" ? undefined : bodyStr,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`relayer ${method} ${path} → ${res.status} ${txt.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }
}

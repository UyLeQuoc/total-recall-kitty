/**
 * Reading both scopes after someone takes ownership.
 *
 * Without this, `/connect` was the moment a person's memory disappeared: guest
 * memories live in hippo's account under `hippo-guest:<id>`, owned memories in
 * the user's own account under `hippo`, and nothing read both. Three documents
 * claimed dual-read was built. It was not.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryScope } from "./client.ts";
import { buildMemoryText } from "./format.ts";

const recalls: Array<{ namespace: string; query: string }> = [];
let byNamespace: Record<string, Array<{ blob_id: string; distance: number }>> = {};
let failing: string | null = null;
let dedupeIgnored: ReadonlySet<string> | undefined;
let dedupeCalls = 0;

vi.mock("./client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.ts")>()),
  createClient: (scope: MemoryScope) => ({ __namespace: scope.namespace }),
}));

vi.mock("./policy.ts", () => ({
  recallRelevant: async (
    client: { __namespace: string },
    input: { query: string; limit?: number },
  ) => {
    const ns = client.__namespace;
    recalls.push({ namespace: ns, query: input.query });
    if (failing === ns) throw new Error(`relayer said no for ${ns}`);
    return (byNamespace[ns] ?? []).map((m) => ({ ...m, text: `from ${ns}`, parsed: null }));
  },
  rememberWithDedupe: async (_client: unknown, opts: { ignore?: ReadonlySet<string> }) => {
    dedupeIgnored = opts.ignore;
    dedupeCalls += 1;
    return {
      status: "accepted",
      jobId: "j",
      settled: Promise.resolve({ status: "stored", blobId: "b", attempts: 1 }),
    };
  },
}));

const { createMemoryPort } = await import("./port.ts");

const owned: MemoryScope = {
  mode: "owned",
  key: "a".repeat(64),
  accountId: `0x${"1".repeat(64)}`,
  serverUrl: "https://relayer.example",
  namespace: "hippo",
};
const guest: MemoryScope = {
  mode: "guest",
  key: "b".repeat(64),
  accountId: `0x${"2".repeat(64)}`,
  serverUrl: "https://relayer.example",
  namespace: "hippo-guest:person-1",
};

const port = () => createMemoryPort({ scope: owned, by: "uy", channel: "web", alsoRead: [guest] });

beforeEach(() => {
  recalls.length = 0;
  byNamespace = {};
  failing = null;
  dedupeCalls = 0;
});

describe("recall after taking ownership", () => {
  it("returns memories from before the user owned anything", async () => {
    byNamespace = {
      hippo: [{ blob_id: "new", distance: 0.4 }],
      "hippo-guest:person-1": [{ blob_id: "old", distance: 0.2 }],
    };
    const hits = await port().recall({ query: "what do you know" });
    expect(hits.map((h) => h.blob_id)).toEqual(["old", "new"]);
  });

  it("reads the two scopes one after another, never at once", async () => {
    byNamespace = { hippo: [], "hippo-guest:person-1": [] };
    await port().recall({ query: "q" });
    // Concurrent recalls make the relayer drop matches (SPIKES §H). The order
    // matters less than the fact that there are two separate sequential calls.
    expect(recalls.map((r) => r.namespace)).toEqual(["hippo", "hippo-guest:person-1"]);
  });

  it("does not lose the owned account when the old scope fails", async () => {
    byNamespace = { hippo: [{ blob_id: "new", distance: 0.3 }] };
    failing = "hippo-guest:person-1";
    const hits = await port().recall({ query: "q" });
    expect(hits.map((h) => h.blob_id)).toEqual(["new"]);
  });

  it("does not return the same blob twice", async () => {
    byNamespace = {
      hippo: [{ blob_id: "same", distance: 0.3 }],
      "hippo-guest:person-1": [{ blob_id: "same", distance: 0.9 }],
    };
    const hits = await port().recall({ query: "q" });
    expect(hits).toHaveLength(1);
    // The better score wins, which is the one from the account they own.
    expect(hits[0]?.distance).toBe(0.3);
  });

  it("honours the caller's limit across both scopes", async () => {
    byNamespace = {
      hippo: [
        { blob_id: "a", distance: 0.1 },
        { blob_id: "b", distance: 0.5 },
      ],
      "hippo-guest:person-1": [{ blob_id: "c", distance: 0.2 }],
    };
    const hits = await port().recall({ query: "q", limit: 2 });
    expect(hits.map((h) => h.blob_id)).toEqual(["a", "c"]);
  });

  it("leaves a guest-only port reading exactly one scope", async () => {
    byNamespace = { "hippo-guest:person-1": [{ blob_id: "old", distance: 0.2 }] };
    const solo = createMemoryPort({ scope: guest, by: "uy", channel: "web" });
    await solo.recall({ query: "q" });
    expect(recalls).toHaveLength(1);
  });
});

describe("hidden memories", () => {
  const hiddenPort = () =>
    createMemoryPort({
      scope: owned,
      by: "uy",
      channel: "web",
      alsoRead: [guest],
      hidden: new Set(["old", "shown-twice"]),
    });

  it("never come back from recall, in either scope", async () => {
    byNamespace = {
      hippo: [
        { blob_id: "keep", distance: 0.2 },
        { blob_id: "shown-twice", distance: 0.3 },
      ],
      "hippo-guest:person-1": [
        { blob_id: "old", distance: 0.1 },
        { blob_id: "keep-too", distance: 0.4 },
      ],
    };
    const got = await hiddenPort().recall({ query: "q" });
    expect(got.map((m) => m.blob_id)).toEqual(["keep", "keep-too"]);
  });

  it("are never treated as a duplicate of something said again", async () => {
    await hiddenPort().remember({ type: "profile", text: "I use VS Code" });
    expect(dedupeIgnored?.has("old")).toBe(true);
  });
});

describe("retry of a fact already stored", () => {
  const line = () =>
    buildMemoryText({ type: "profile", by: "uy", channel: "web", text: "I use pnpm" });
  const hash = () => bytesToHex(sha256(new TextEncoder().encode(line())));

  it("does not call remember again when the formatted line is already known", async () => {
    const result = await port().remember({
      type: "profile",
      text: "I use pnpm",
      channel: "web",
      knownHashes: new Set([hash()]),
    });
    expect(result.saved).toBe(false);
    expect(result.note).toContain("nothing written");
    expect(dedupeCalls).toBe(0);
  });

  it("still stores a line that is not in the known set", async () => {
    const result = await port().remember({
      type: "profile",
      text: "I use pnpm",
      channel: "web",
      knownHashes: new Set(["not-this-line"]),
    });
    expect(result.saved).toBe(true);
    expect(dedupeCalls).toBe(1);
  });
});

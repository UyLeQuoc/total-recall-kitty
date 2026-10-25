import type { MemWal } from "@mysten-incubation/memwal";
import { describe, expect, it } from "vitest";
import { parseMemoryText } from "./format.ts";
import { orderNewestFirst, type RecalledMemory, rememberWithDedupe } from "./policy.ts";
import { formatUntrustedMemories } from "./untrusted.ts";

function mem(text: string, distance: number, created_at?: string): RecalledMemory {
  return { blob_id: text, text, distance, created_at, parsed: parseMemoryText(text) };
}

const stale = mem(
  "[profile] [by:@mai] [2026-09-24] I only use pnpm",
  0.31,
  "2026-09-24T10:00:00.000Z",
);
const fix = mem(
  "[correction] [by:@mai] [2026-09-24] We moved from pnpm to bun",
  0.34,
  "2026-09-24T10:04:12.000Z",
);

describe("orderNewestFirst", () => {
  it("puts a correction ahead of the fact it replaced, even when the fact is closer", () => {
    // The shape measured on production: the stale memory ranked higher.
    const ordered = orderNewestFirst([stale, fix]);
    expect(ordered.map((m) => m.blob_id)).toEqual([fix.blob_id, stale.blob_id]);
  });

  it("orders by write time within a single day, which the text date cannot", () => {
    // Same [2026-09-24] in both texts; only created_at separates them.
    expect(stale.parsed?.date).toBe(fix.parsed?.date);
    expect(orderNewestFirst([stale, fix])[0]).toBe(fix);
  });

  it("falls back to the text date when the relayer omits created_at", () => {
    const older = mem("[profile] [by:@mai] [2026-09-20] Deploys to Fly", 0.2);
    const newer = mem("[correction] [by:@mai] [2026-09-23] Deploys to Railway now", 0.5);
    expect(orderNewestFirst([older, newer])[0]).toBe(newer);
  });

  it("sorts undated memories last, so they never outrank a dated correction", () => {
    const undated = mem("the user likes pnpm", 0.1);
    expect(orderNewestFirst([undated, fix]).at(-1)).toBe(undated);
  });

  it("keeps relevance order among memories written at the same moment", () => {
    const a = mem("[profile] [by:@mai] [2026-09-24] a", 0.5, "2026-09-24T10:00:00.000Z");
    const b = mem("[profile] [by:@mai] [2026-09-24] b", 0.2, "2026-09-24T10:00:00.000Z");
    expect(orderNewestFirst([a, b])[0]).toBe(b);
  });

  it("does not mutate its input", () => {
    const input = [stale, fix];
    orderNewestFirst(input);
    expect(input[0]).toBe(stale);
  });
});

describe("formatUntrustedMemories", () => {
  const nonce = "0".repeat(32);

  it("carries the write time so the conflict rule has something to compare", () => {
    const block = formatUntrustedMemories([fix], nonce);
    expect(block).toContain('"stored":"2026-09-24T10:04:12.000Z"');
  });

  it("falls back to the text date, and omits the field when there is neither", () => {
    const dated = mem("[profile] [by:@mai] [2026-09-20] Deploys to Fly", 0.2);
    expect(formatUntrustedMemories([dated], nonce)).toContain('"stored":"2026-09-20"');
    expect(formatUntrustedMemories([mem("no date here", 0.2)], nonce)).not.toContain("stored");
  });
});

/** A relayer that already holds one memory, at a fixed distance from anything. */
function relayerHolding(existing: string, distance: number) {
  const written: string[] = [];
  const client = {
    recall: async () => ({ results: [{ blob_id: "old", text: existing, distance }], total: 1 }),
    remember: async (text: string) => {
      written.push(text);
      return { job_id: "job" };
    },
    waitForRememberJob: async () => ({ blob_id: "new" }),
  } as unknown as MemWal;
  return { client, written };
}

describe("rememberWithDedupe", () => {
  // Distances measured on mainnet by scripts/spike-corrections.ts.
  const vscode = "[profile] [by:@u] [2026-09-24] I use VS Code with vim bindings.";
  const neovim = "[correction] [by:@u] [2026-09-24] I moved to Neovim; I no longer use VS Code.";

  it("writes a correction even when it sits within duplicate distance of the fact it replaces", async () => {
    const { client, written } = relayerHolding(vscode, 0.243);
    const out = await rememberWithDedupe(client, { text: neovim, namespace: "ns" });
    expect(out.status).toBe("accepted");
    expect(written).toEqual([neovim]);
  });

  it("still treats a repeated correction as a duplicate", async () => {
    const { client, written } = relayerHolding(neovim, 0.05);
    const out = await rememberWithDedupe(client, { text: neovim, namespace: "ns" });
    expect(out.status).toBe("duplicate");
    expect(written).toEqual([]);
  });

  it("does not count a hidden memory as a duplicate", async () => {
    const { client, written } = relayerHolding(vscode, 0.05);
    const out = await rememberWithDedupe(client, {
      text: vscode,
      namespace: "ns",
      ignore: new Set(["old"]),
    });
    expect(out.status).toBe("accepted");
    expect(written).toEqual([vscode]);
  });

  it("writes a near-identical structured record when dedupe is off, without a recall", async () => {
    const joined = "[episode] [by:@kitty] [2026-10-24] JOINED member=0xb (Bao) cap=$0.40";
    const { client, written } = relayerHolding(
      "[episode] [by:@kitty] [2026-10-24] JOINED member=0xa (Ava) cap=$0.40",
      0.03,
    );
    let recalls = 0;
    const counting = {
      ...client,
      recall: async (...a: unknown[]) => {
        recalls++;
        return (client.recall as (...x: unknown[]) => unknown)(...a);
      },
    } as unknown as MemWal;
    const out = await rememberWithDedupe(counting, {
      text: joined,
      namespace: "ns",
      dedupe: false,
    });
    expect(out.status).toBe("accepted");
    expect(written).toEqual([joined]);
    expect(recalls).toBe(0);
  });

  it("leaves ordinary dedupe alone", async () => {
    const again = "[profile] [by:@u] [2026-09-24] I use VS Code, with vim keys.";
    const { client, written } = relayerHolding(vscode, 0.12);
    const out = await rememberWithDedupe(client, { text: again, namespace: "ns" });
    expect(out.status).toBe("duplicate");
    expect(written).toEqual([]);
  });
});

/**
 * The keeper against the local dev database, with a fake chain and a fake memory (ADR-0062). CI has no
 * Postgres, so these skip themselves there.
 */
import { randomUUID } from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KittyChain } from "./chain.ts";
import { micro } from "./chain.ts";
import { createDb, inflows, members, memories, pots, pulls } from "./db/index.ts";
import { onInflow, pullMember } from "./keeper.ts";
import type { KittyMemory } from "./memory.ts";

const db = createDb(process.env.DATABASE_URL ?? "postgres://kitty:kitty@localhost:5436/kitty");
let up = false;
const tag = randomUUID().slice(0, 8);
const potId = `0xtest${tag}`;
const addr = (n: number) => `0x${tag}${n.toString().padStart(56, "0")}`;
const [A, C] = [addr(1), addr(3)];
const balances = new Map<string, bigint>([
  [A, micro(1)],
  [C, micro(0.05)],
]);
const sent: string[] = [];
const chain = {
  packageId: "0x1",
  typeOrigin: "0x1",
  coinType: "0x2::usdc::USDC",
  sponsor: "0x5",
  client: {} as never,
  async run() {
    const digest = `digest-${tag}-${sent.length + 1}`;
    sent.push(digest);
    return { digest, success: true, error: null, created: [], events: [] };
  },
  async usdcAddressBalance(owner: string) {
    return balances.get(owner) ?? 0n;
  },
} satisfies KittyChain;
const memory: KittyMemory = {
  async remember(namespace, kind, text) {
    const id = randomUUID();
    await db.insert(memories).values({
      id,
      namespace,
      kind,
      text,
      sha256: id,
      status: "stored",
      blobId: `blob-${id.slice(0, 8)}`,
    });
    return { id, saved: true };
  },
  async recall() {
    return [];
  },
  async flush() {},
};
const deps = { db, chain, keeper: Ed25519Keypair.generate(), memory, ours: new Set<string>() };

beforeAll(async () => {
  up = await Promise.race([
    db.execute("select 1 from kitty.pots limit 1").then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
  ]).catch(() => false);
  if (!up) return;
  await db.insert(pots).values({
    id: potId,
    name: "unit test",
    goal: micro(1.5),
    deadline: new Date(Date.now() + 3 * 3600_000),
    keeper: "0x6",
    quorum: 2,
    autoOkCap: 0n,
    windowMs: 3600_000,
    coinType: chain.coinType,
    createDigest: "d",
  });
  const m = (address: string, name: string) => ({
    potId,
    address,
    name,
    test: true,
    capPerWindow: micro(0.4),
    allowanceId: "0xa",
    allowanceCapId: "0xb",
    allowanceName: "kitty:test",
    joinDigest: "d",
  });
  await db.insert(members).values([m(A, "Ava"), m(C, "Chi")]);
});

afterAll(async () => {
  if (!up) return;
  await db.delete(pulls).where(eq(pulls.potId, potId));
  await db.delete(inflows).where(eq(inflows.potId, potId));
  await db.delete(members).where(eq(members.potId, potId));
  await db.delete(pots).where(eq(pots.id, potId));
  for (const ns of [`kitty:pot:${potId}:members`, `kitty:pot:${potId}:norms`])
    await db.delete(memories).where(eq(memories.namespace, ns));
});

const row = async (a: string) =>
  (await db.select().from(members).where(eq(members.address, a)))[0] as typeof members.$inferSelect;
const pot = async () =>
  (await db.select().from(pots).where(eq(pots.id, potId)))[0] as typeof pots.$inferSelect;

describe("the keeper", () => {
  it("pulls a member who can pay, and skips one who can't without sending anything", async (ctx) => {
    if (!up) return ctx.skip();
    const a = await pullMember(deps, await pot(), await row(A));
    expect(a.status).toBe("sent");
    expect((await row(A)).contributed).toBe(a.amount);
    const before = sent.length;
    const c = await pullMember(deps, await pot(), await row(C));
    expect(c.status).toBe("skipped");
    expect(sent.length).toBe(before);
    expect(c.reason).toMatch(/no transaction and no fee/);
    expect((await row(C)).nextPullAt).not.toBeNull();
  });

  it("doesn't pull twice in one window", async (ctx) => {
    if (!up) return ctx.skip();
    expect((await pullMember(deps, await pot(), await row(A))).status).toBe("not_due");
  });

  it("treats an inflow as a payday, ignores Kitty's own transactions, and cites the memory in the next pull", async (ctx) => {
    if (!up) return ctx.skip();
    deps.ours.add("ours-1");
    expect(await onInflow(deps, C, micro(1), "ours-1", 1)).toBeNull();
    balances.set(C, micro(0.55));
    expect(await onInflow(deps, C, micro(0.5), `payday-${tag}`, 2)).toEqual([potId]);
    const scheduled = await row(C);
    expect(scheduled.scheduleMemoryId).toBeTruthy();
    const c = await pullMember(deps, await pot(), scheduled);
    expect(c.status).toBe("sent");
    expect(c.reason).toMatch(/right after Chi's payday .* \(memory blob-/);
    expect(c.memoryId).toBe(scheduled.scheduleMemoryId);
  });

  it("never pulls a member who left", async (ctx) => {
    if (!up) return ctx.skip();
    await db.update(members).set({ active: false }).where(eq(members.address, C));
    expect((await pullMember(deps, await pot(), await row(C), { force: true })).status).toBe(
      "not_due",
    );
  });
});

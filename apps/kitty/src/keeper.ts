/**
 * The keeper (KT2, ADR-0062): pulls each member's share when it's due.
 * - It **checks the member's address balance first** (Tatum gRPC `GetBalance`). A share the balance can't
 *   cover sends no transaction; a memory records the skip, and the next pull waits for an inflow.
 * - An inflow (the filtered stream) is a payday: it goes to memory, and the next pull follows it at once,
 *   with a reason that cites that memory.
 */
import { randomUUID } from "node:crypto";
import type { Keypair } from "@mysten/sui/cryptography";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { and, desc, eq } from "drizzle-orm";
import { addContribute, ChainAbort, type KittyChain } from "./chain.ts";
import { type Db, inflows, members, memories, pots, pulls } from "./db/index.ts";
import { parsePayday, shareFor, text } from "./learn.ts";
import { type KittyMemory, ns } from "./memory.ts";

export type Log = (msg: string, data?: Record<string, unknown>) => void;

export interface KeeperDeps {
  db: Db;
  chain: KittyChain;
  keeper: Keypair;
  memory: KittyMemory | null;
  log?: Log;
  now?: () => Date;
  /** Digests Kitty itself sent; their balance changes are not paydays. */
  ours?: Set<string>;
}

type Member = typeof members.$inferSelect;
type Pot = typeof pots.$inferSelect;

async function remember(
  deps: KeeperDeps,
  namespace: string,
  kind: "episode" | "profile" | "decision" | "rule",
  t: string,
) {
  if (!deps.memory) return null;
  const r = await deps.memory.remember(namespace, kind, t).catch((err) => {
    deps.log?.("memory.failed", { error: String(err) });
    return null;
  });
  return r?.id || null;
}

async function blobOf(db: Db, memoryId: string | null) {
  if (!memoryId) return null;
  const [row] = await db.select().from(memories).where(eq(memories.id, memoryId));
  return row ?? null;
}

export interface PullOutcome {
  member: string;
  status: "sent" | "skipped" | "not_due" | "aborted";
  amount: bigint;
  digest?: string;
  reason: string;
  memoryId?: string | null;
}

/** One member, now: decide, check the balance, pull or skip. */
export async function pullMember(
  deps: KeeperDeps,
  pot: Pot,
  m: Member,
  opts: { force?: boolean; amount?: bigint; send?: boolean } = {},
): Promise<PullOutcome> {
  const { db, chain } = deps;
  const now = deps.now?.() ?? new Date();
  if (!m.active)
    return { member: m.address, status: "not_due", amount: 0n, reason: "left the pot" };
  if (!opts.force) {
    if (m.nextPullAt && now < m.nextPullAt)
      return {
        member: m.address,
        status: "not_due",
        amount: 0n,
        reason: `next pull ${m.nextPullAt.toISOString()}`,
      };
    const [last] = await db
      .select()
      .from(pulls)
      .where(and(eq(pulls.potId, pot.id), eq(pulls.member, m.address), eq(pulls.status, "sent")))
      .orderBy(desc(pulls.createdAt))
      .limit(1);
    if (last && now.getTime() - last.createdAt.getTime() < pot.windowMs) {
      return {
        member: m.address,
        status: "not_due",
        amount: 0n,
        reason: "already pulled this window",
      };
    }
  }
  const all = await db.select().from(members).where(eq(members.potId, pot.id));
  const totalIn = all.reduce((s, x) => s + x.contributed, 0n);
  const share = shareFor({
    goal: pot.goal,
    totalIn,
    deadlineMs: pot.deadline.getTime(),
    windowMs: pot.windowMs,
    nowMs: now.getTime(),
    activeMembers: all.filter((x) => x.active).length,
    capPerWindow: m.capPerWindow,
    contributed: m.contributed,
  });
  const amount = opts.amount ?? share.amount;
  if (amount <= 0n)
    return { member: m.address, status: "not_due", amount: 0n, reason: "the goal is met" };

  const balance = await chain.usdcAddressBalance(m.address);
  if (balance < amount) {
    const t = text.skip({ member: m.address, name: m.name, balance, share: amount, at: now });
    const memoryId = await remember(deps, ns.members(pot.id), "episode", t);
    await db.insert(pulls).values({
      id: randomUUID(),
      potId: pot.id,
      member: m.address,
      amount,
      status: "skipped",
      reason: t,
      memoryId,
    });
    // Wait for an inflow; retry once a window in case the stream missed it.
    await db
      .update(members)
      .set({ nextPullAt: new Date(now.getTime() + pot.windowMs), scheduleMemoryId: memoryId })
      .where(and(eq(members.potId, pot.id), eq(members.address, m.address)));
    deps.log?.("keeper.skipped", {
      pot: pot.id,
      member: m.address,
      balance: String(balance),
      share: String(amount),
    });
    return { member: m.address, status: "skipped", amount, reason: t, memoryId };
  }

  // Why now: after a payday the stream saw, or just the scheduled share.
  const schedule = await blobOf(db, m.scheduleMemoryId);
  const payday = schedule ? parsePayday(schedule.text) : null;
  let why = "as the scheduled share";
  let memoryId: string | null = null;
  if (payday && schedule) {
    why = `right after ${m.name}'s payday on ${payday.at} (memory ${schedule.blobId ?? schedule.id})`;
    memoryId = schedule.id;
  }
  if (share.behind > 0n && !opts.amount && !payday) {
    memoryId = await remember(
      deps,
      ns.members(pot.id),
      "decision",
      text.behind({ member: m.address, name: m.name, behind: share.behind, amount }),
    );
    why = "with a catch-up for being behind plan";
  }
  const id = randomUUID();
  try {
    const done = await chain.run(
      deps.keeper,
      (tx) =>
        addContribute(tx, chain.packageId, chain.coinType, {
          potId: pot.id,
          allowanceId: m.allowanceId,
          member: m.address,
          amount,
        }),
      opts.send ? { send: true } : {},
    );
    deps.ours?.add(done.digest);
    const reason = text.pulled({ member: m.address, name: m.name, amount, why });
    await db.insert(pulls).values({
      id,
      potId: pot.id,
      member: m.address,
      amount,
      status: "sent",
      digest: done.digest,
      reason,
      memoryId,
    });
    await db
      .update(members)
      .set({ contributed: m.contributed + amount, nextPullAt: null, scheduleMemoryId: null })
      .where(and(eq(members.potId, pot.id), eq(members.address, m.address)));
    if (payday) await remember(deps, ns.members(pot.id), "episode", reason);
    deps.log?.("keeper.pulled", {
      pot: pot.id,
      member: m.address,
      amount: String(amount),
      digest: done.digest,
    });
    return { member: m.address, status: "sent", amount, digest: done.digest, reason, memoryId };
  } catch (err) {
    if (!(err instanceof ChainAbort)) throw err;
    if (err.digest) deps.ours?.add(err.digest);
    await db.insert(pulls).values({
      id,
      potId: pot.id,
      member: m.address,
      amount,
      status: "aborted",
      ...(err.digest ? { digest: err.digest } : {}),
      reason: `aborted onchain: ${err.detail.slice(0, 200)}`,
      error: err.detail,
    });
    deps.log?.("keeper.aborted", {
      pot: pot.id,
      member: m.address,
      error: err.detail.slice(0, 200),
    });
    return {
      member: m.address,
      status: "aborted",
      amount,
      ...(err.digest ? { digest: err.digest } : {}),
      reason: err.detail,
    };
  }
}

/** Every open pot, every member who's due. */
export async function keeperPass(deps: KeeperDeps) {
  const out: PullOutcome[] = [];
  for (const pot of await deps.db.select().from(pots).where(eq(pots.closed, false))) {
    for (const m of await deps.db.select().from(members).where(eq(members.potId, pot.id))) {
      out.push(
        await pullMember(deps, pot, m).catch((err) => ({
          member: m.address,
          status: "aborted" as const,
          amount: 0n,
          reason: String(err),
        })),
      );
    }
  }
  return out;
}

/**
 * A member's address received money (not from Kitty itself): remember it as a payday, and schedule
 * their pull right after it.
 */
export async function onInflow(
  deps: KeeperDeps,
  member: string,
  amount: bigint,
  digest: string,
  checkpoint: number | null,
) {
  const { db } = deps;
  if (deps.ours?.has(digest)) return null;
  const address = normalizeSuiAddress(member);
  const rows = await db
    .select()
    .from(members)
    .where(and(eq(members.address, address), eq(members.active, true)));
  const now = deps.now?.() ?? new Date();
  const out: string[] = [];
  for (const m of rows) {
    const inserted = await db
      .insert(inflows)
      .values({ digest, member: address, potId: m.potId, amount, checkpoint })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length) continue;
    const memoryId = await remember(
      deps,
      ns.members(m.potId),
      "profile",
      text.payday({ member: address, name: m.name, amount, at: now, digest }),
    );
    await db
      .update(inflows)
      .set({ memoryId })
      .where(
        and(eq(inflows.digest, digest), eq(inflows.member, address), eq(inflows.potId, m.potId)),
      );
    await db
      .update(members)
      .set({ nextPullAt: now, scheduleMemoryId: memoryId })
      .where(and(eq(members.potId, m.potId), eq(members.address, address)));
    deps.log?.("keeper.payday", { pot: m.potId, member: address, amount: String(amount), digest });
    out.push(m.potId);
  }
  return out;
}

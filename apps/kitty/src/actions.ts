/**
 * What members do (KT2, ADR-0062): create a pot, join with one signature, propose and approve, spend
 * inside the auto-ok cap, leave, close. Each writes the chain first, then the mirror, then memory.
 *
 * The member signs with their own wallet through the web (`deps.signer`, ADR-0064), or, for a labelled
 * test member, with the key Kitty holds.
 */
import { randomUUID } from "node:crypto";
import type { Keypair } from "@mysten/sui/cryptography";
import type { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  addApprove,
  addApproveAsDelegate,
  addCreate,
  addDepositCoins,
  addExecute,
  addJoin,
  addLeave,
  addPropose,
  addProposeAsDelegate,
  addRevokeDelegate,
  addSetDelegate,
  addSpendAuto,
  ChainAbort,
  coinIds,
  type Executed,
  type KittyChain,
  readPot,
  type Signer,
  same,
} from "./chain.ts";
import {
  type Approval,
  type Db,
  delegates,
  members,
  memories,
  pots,
  proposals,
  spends,
} from "./db/index.ts";
import { categoryOf, type SpendNorm, suggestAutoOk, text } from "./learn.ts";
import { type KittyMemory, ns } from "./memory.ts";

export interface ActionDeps {
  db: Db;
  chain: KittyChain;
  memory: KittyMemory | null;
  /** Server-held keys of labelled test members (no Enoki key for zkLogin, ADR-0062). */
  keys: Map<string, Keypair>;
  /** The member's own wallet, when the action comes from the web (ADR-0064). */
  signer?: Signer;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  now?: () => Date;
  ours?: Set<string>;
}

export class ActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const keyOf = (deps: ActionDeps, address: string): Signer => {
  if (deps.signer) {
    if (!same(deps.signer.toSuiAddress(), address))
      throw new ActionError("not_signer", "Only that member's own wallet can sign this.");
    return deps.signer;
  }
  const k = deps.keys.get(normalizeSuiAddress(address));
  if (!k)
    throw new ActionError(
      "no_key",
      "Kitty doesn't hold this member's key. Sign with your wallet instead.",
    );
  return k;
};

async function remember(
  deps: ActionDeps,
  namespace: string,
  kind: "episode" | "decision" | "rule" | "profile" | "source",
  t: string,
) {
  if (!deps.memory) return null;
  const r = await deps.memory.remember(namespace, kind, t).catch((err) => {
    deps.log?.("memory.failed", { error: String(err) });
    return null;
  });
  return r?.id || null;
}

export async function createPot(
  deps: ActionDeps,
  a: {
    creator: string;
    name: string;
    goal: bigint;
    deadline: Date;
    quorum: number;
    autoOkCap: bigint;
    windowMs: number;
    keeper: string;
  },
) {
  const done = await deps.chain.run(keyOf(deps, a.creator), (tx) =>
    addCreate(tx, deps.chain.packageId, deps.chain.coinType, {
      name: a.name,
      goal: a.goal,
      deadlineMs: a.deadline.getTime(),
      keeper: a.keeper,
      quorum: a.quorum,
      autoOkCap: a.autoOkCap,
    }),
  );
  deps.ours?.add(done.digest);
  const potId = done.created.find((c) => c.type.includes("::pot::Pot<"))?.id;
  if (!potId) throw new Error(`no Pot in ${done.digest}`);
  await deps.db.insert(pots).values({
    id: potId,
    name: a.name,
    goal: a.goal,
    deadline: a.deadline,
    keeper: normalizeSuiAddress(a.keeper),
    quorum: a.quorum,
    autoOkCap: a.autoOkCap,
    windowMs: a.windowMs,
    coinType: deps.chain.coinType,
    createDigest: done.digest,
  });
  return { potId, digest: done.digest };
}

export async function joinPot(
  deps: ActionDeps,
  a: { potId: string; member: string; name: string; capPerWindow: bigint; test: boolean },
) {
  const [pot] = await deps.db.select().from(pots).where(eq(pots.id, a.potId));
  if (!pot) throw new ActionError("not_found", "No such pot.");
  const allowanceName = `kitty:${pot.id.slice(2, 18)}`;
  const done = await deps.chain.run(keyOf(deps, a.member), (tx) =>
    addJoin(tx, deps.chain.packageId, deps.chain.coinType, {
      potId: pot.id,
      allowanceName,
      keeper: pot.keeper,
      capPerWindow: a.capPerWindow,
      windowMs: pot.windowMs,
      expiryMs: pot.deadline.getTime(),
      typeOrigin: deps.chain.typeOrigin,
    }),
  );
  deps.ours?.add(done.digest);
  const allowanceId = done.created.find((c) => c.type.includes("::allowance::Allowance<"))?.id;
  const capId = done.created.find((c) => c.type.includes("::allowance::AllowanceCap<"))?.id;
  if (!allowanceId || !capId) throw new Error(`no allowance in ${done.digest}`);
  const address = normalizeSuiAddress(a.member);
  await deps.db.insert(members).values({
    potId: pot.id,
    address,
    name: a.name,
    // A wallet that is one of the generated test keys stays labelled test.
    test: a.test || deps.keys.has(address),
    capPerWindow: a.capPerWindow,
    allowanceId,
    allowanceCapId: capId,
    allowanceName,
    joinDigest: done.digest,
  });
  await remember(
    deps,
    ns.members(pot.id),
    "episode",
    text.joined({ member: address, name: a.name, cap: a.capPerWindow, windowMs: pot.windowMs }),
  );
  return { allowanceId, capId, digest: done.digest };
}

export type ProposalInput =
  | { kind: "spend"; payee: string; amount: bigint; memo: string }
  | { kind: "auto_cap"; cap: bigint }
  | { kind: "close" };

export async function propose(deps: ActionDeps, potId: string, proposer: string, p: ProposalInput) {
  const done = await deps.chain.run(keyOf(deps, proposer), (tx) =>
    addPropose(tx, deps.chain.packageId, deps.chain.coinType, potId, p),
  );
  deps.ours?.add(done.digest);
  // Proposals are numbered onchain from 0; every one goes through Kitty, so the mirror's count is the id.
  const [last] = await deps.db
    .select()
    .from(proposals)
    .where(eq(proposals.potId, potId))
    .orderBy(desc(proposals.seq))
    .limit(1);
  const seq = last ? last.seq + 1 : 0;
  await deps.db.insert(proposals).values({
    potId,
    seq,
    kind: p.kind,
    payee: p.kind === "spend" ? normalizeSuiAddress(p.payee) : null,
    amount: p.kind === "spend" ? p.amount : p.kind === "auto_cap" ? p.cap : null,
    memo: p.kind === "spend" ? p.memo : null,
    proposer: normalizeSuiAddress(proposer),
    approvals: [
      { member: normalizeSuiAddress(proposer), at: (deps.now?.() ?? new Date()).toISOString() },
    ],
    digest: done.digest,
  });
  return { seq, digest: done.digest };
}

/** Approve, and execute in the same transaction when `execute` (the approval that reaches quorum). */
export async function approve(
  deps: ActionDeps,
  potId: string,
  seq: number,
  member: string,
  execute = false,
) {
  const done = await deps.chain.run(keyOf(deps, member), (tx) =>
    addApprove(tx, deps.chain.packageId, deps.chain.coinType, potId, seq, execute),
  );
  deps.ours?.add(done.digest);
  const [p] = await deps.db
    .select()
    .from(proposals)
    .where(and(eq(proposals.potId, potId), eq(proposals.seq, seq)));
  if (!p) throw new ActionError("not_found", "No such proposal.");
  const approvals = [
    ...p.approvals,
    { member: normalizeSuiAddress(member), at: (deps.now?.() ?? new Date()).toISOString() },
  ];
  await deps.db
    .update(proposals)
    .set({ approvals })
    .where(and(eq(proposals.potId, potId), eq(proposals.seq, seq)));
  return execute ? afterExecute(deps, potId, seq, done.digest) : { digest: done.digest };
}

/** Execute alone: aborts onchain (`EUnderQuorum`) when the approvals aren't there yet. */
export async function execute(
  deps: ActionDeps,
  potId: string,
  seq: number,
  member: string,
  send = false,
) {
  const done = await deps.chain.run(
    keyOf(deps, member),
    (tx) => addExecute(tx, deps.chain.packageId, deps.chain.coinType, potId, seq),
    send ? { send: true } : {},
  );
  deps.ours?.add(done.digest);
  return afterExecute(deps, potId, seq, done.digest);
}

async function afterExecute(deps: ActionDeps, potId: string, seq: number, digest: string) {
  const now = deps.now?.() ?? new Date();
  const [p] = await deps.db
    .select()
    .from(proposals)
    .where(and(eq(proposals.potId, potId), eq(proposals.seq, seq)));
  if (!p) throw new ActionError("not_found", "No such proposal.");
  await deps.db
    .update(proposals)
    .set({ executed: true, executedAt: now, digest })
    .where(and(eq(proposals.potId, potId), eq(proposals.seq, seq)));
  const minutes = Math.max(0, Math.round((now.getTime() - p.createdAt.getTime()) / 60_000));
  let suggestion: { category: string; cap: bigint; n: number; memoryId: string | null } | null =
    null;
  if (p.kind === "spend" && p.payee && p.amount !== null) {
    await deps.db.insert(spends).values({
      id: randomUUID(),
      potId,
      payee: p.payee,
      amount: p.amount,
      memo: p.memo ?? "",
      auto: false,
      proposalSeq: seq,
      digest,
    });
    const category = categoryOf(p.memo ?? "");
    await remember(
      deps,
      ns.norms(potId),
      "decision",
      text.approved({ seq, category, amount: p.amount, minutes, approvals: p.approvals.length }),
    );
    suggestion = await maybeSuggest(deps, potId);
  } else if (p.kind === "auto_cap" && p.amount !== null) {
    await deps.db.update(pots).set({ autoOkCap: p.amount }).where(eq(pots.id, potId));
    await remember(
      deps,
      ns.norms(potId),
      "rule",
      text.rule({ cap: p.amount, seq, approvals: p.approvals.length }),
    );
  } else if (p.kind === "close") {
    const before = await deps.db.select().from(members).where(eq(members.potId, potId));
    const totalIn = before.reduce((s, m) => s + m.contributed, 0n);
    const spent = (await deps.db.select().from(spends).where(eq(spends.potId, potId))).reduce(
      (s, x) => s + x.amount,
      0n,
    );
    await deps.db.update(pots).set({ closed: true }).where(eq(pots.id, potId));
    await remember(
      deps,
      ns.members(potId),
      "episode",
      text.closed({ refunded: totalIn - spent, totalIn, totalOut: spent }),
    );
  }
  return { digest, suggestion };
}

/** After each spend: has the group been acting out an auto-ok rule it hasn't voted yet? */
export async function maybeSuggest(deps: ActionDeps, potId: string) {
  const [pot] = await deps.db.select().from(pots).where(eq(pots.id, potId));
  if (!pot) return null;
  const done = await deps.db
    .select()
    .from(proposals)
    .where(
      and(eq(proposals.potId, potId), eq(proposals.kind, "spend"), eq(proposals.executed, true)),
    )
    .orderBy(asc(proposals.seq));
  const history: SpendNorm[] = done.map((p) => ({
    category: categoryOf(p.memo ?? ""),
    amount: p.amount ?? 0n,
    minutes: p.executedAt ? (p.executedAt.getTime() - p.createdAt.getTime()) / 60_000 : 999,
    approvals: p.approvals.length,
  }));
  const s = suggestAutoOk(history, pot.autoOkCap);
  if (!s) return null;
  const t = text.suggest(s);
  const [already] = await deps.db
    .select()
    .from(memories)
    .where(and(eq(memories.namespace, ns.norms(potId)), eq(memories.text, t)));
  const memoryId = already?.id ?? (await remember(deps, ns.norms(potId), "decision", t));
  return { ...s, memoryId };
}

export async function spendAuto(
  deps: ActionDeps,
  a: { potId: string; member: string; payee: string; amount: bigint; memo: string },
  send = false,
) {
  const done = await deps.chain.run(
    keyOf(deps, a.member),
    (tx) =>
      addSpendAuto(tx, deps.chain.packageId, deps.chain.coinType, {
        potId: a.potId,
        payee: a.payee,
        amount: a.amount,
        memo: a.memo,
      }),
    send ? { send: true } : {},
  );
  deps.ours?.add(done.digest);
  await deps.db.insert(spends).values({
    id: randomUUID(),
    potId: a.potId,
    payee: normalizeSuiAddress(a.payee),
    amount: a.amount,
    memo: a.memo,
    auto: true,
    digest: done.digest,
  });
  return { digest: done.digest };
}

export async function leavePot(deps: ActionDeps, potId: string, member: string) {
  const address = normalizeSuiAddress(member);
  const [m] = await deps.db
    .select()
    .from(members)
    .where(and(eq(members.potId, potId), eq(members.address, address)));
  if (!m) throw new ActionError("not_member", "Not a member.");
  const done = await deps.chain.run(keyOf(deps, address), (tx) =>
    addLeave(tx, deps.chain.packageId, deps.chain.coinType, {
      potId,
      allowanceCapId: m.allowanceCapId,
      allowanceId: m.allowanceId,
    }),
  );
  deps.ours?.add(done.digest);
  await deps.db
    .update(members)
    .set({ active: false, nextPullAt: null })
    .where(and(eq(members.potId, potId), eq(members.address, address)));
  await remember(
    deps,
    ns.members(potId),
    "episode",
    text.left({ member: address, name: m.name, contributed: m.contributed }),
  );
  return { digest: done.digest };
}

/** Moves the member's USDC coins into their address balance, where the keeper's pulls come from. */
export async function depositCoins(deps: ActionDeps, owner: string) {
  const address = normalizeSuiAddress(owner);
  const ids = await coinIds(deps.chain.client, address, deps.chain.coinType);
  if (!ids.length) throw new ActionError("no_coins", "This wallet holds no USDC coins to move.");
  const done = await deps.chain.run(keyOf(deps, address), (tx) =>
    addDepositCoins(tx, deps.chain.coinType, address, ids),
  );
  deps.ours?.add(done.digest);
  return { digest: done.digest, coins: ids.length };
}

export async function potView(deps: Pick<ActionDeps, "db" | "chain">, potId: string) {
  const [pot] = await deps.db.select().from(pots).where(eq(pots.id, potId));
  if (!pot) return null;
  const ms = await deps.db.select().from(members).where(eq(members.potId, potId));
  const ps = await deps.db
    .select()
    .from(proposals)
    .where(eq(proposals.potId, potId))
    .orderBy(desc(proposals.seq));
  const onchain = await readPot(deps.chain.client, potId);
  return { pot, members: ms, proposals: ps, onchain };
}

// ---------- delegates: an agent acts for one member, inside a cap (KT4, ADR-0067) ----------

/** Whether one more approval reaches the quorum `pot::execute` checks (active members, capped). */
export async function reachesQuorum(deps: Pick<ActionDeps, "db">, potId: string, seq: number) {
  const [pot] = await deps.db.select().from(pots).where(eq(pots.id, potId));
  const [p] = await deps.db
    .select()
    .from(proposals)
    .where(and(eq(proposals.potId, potId), eq(proposals.seq, seq)));
  if (!pot || !p) throw new ActionError("not_found", "No such proposal.");
  const active = new Set(
    (await deps.db.select().from(members).where(eq(members.potId, potId)))
      .filter((m) => m.active)
      .map((m) => m.address),
  );
  const have = p.approvals.filter((a) => active.has(a.member)).length;
  return have + 1 >= Math.min(pot.quorum, active.size);
}

/** The member's current delegate, if any. */
export async function currentDelegate(deps: Pick<ActionDeps, "db">, potId: string, member: string) {
  const [d] = await deps.db
    .select()
    .from(delegates)
    .where(
      and(
        eq(delegates.potId, potId),
        eq(delegates.member, normalizeSuiAddress(member)),
        eq(delegates.active, true),
      ),
    )
    .orderBy(desc(delegates.createdAt))
    .limit(1);
  return d ?? null;
}

async function memberOf(deps: Pick<ActionDeps, "db">, potId: string, member: string) {
  const [m] = await deps.db
    .select()
    .from(members)
    .where(and(eq(members.potId, potId), eq(members.address, normalizeSuiAddress(member))));
  if (!m) throw new ActionError("not_member", "Not a member of this pot.");
  return m;
}

/** The agent itself signs (its MCP server holds the key); Kitty never holds an agent's key. */
const agentSigner = (deps: ActionDeps, agent: string): Signer => {
  if (!deps.signer || !same(deps.signer.toSuiAddress(), agent))
    throw new ActionError("not_signer", "Only the agent's own key can sign this.");
  return deps.signer;
};

/** Member: names `agent` to propose spends and approve them for this member, up to `approveCap`. */
export async function setDelegate(
  deps: ActionDeps,
  a: { potId: string; member: string; agent: string; approveCap: bigint },
) {
  const m = await memberOf(deps, a.potId, a.member);
  const agent = normalizeSuiAddress(a.agent);
  if (same(agent, m.address))
    throw new ActionError("bad_request", "The agent needs its own address, not yours.");
  const done = await deps.chain.run(keyOf(deps, m.address), (tx) =>
    addSetDelegate(tx, deps.chain.packageId, deps.chain.coinType, {
      potId: a.potId,
      agent,
      approveCap: a.approveCap,
    }),
  );
  deps.ours?.add(done.digest);
  const now = deps.now?.() ?? new Date();
  await deps.db
    .update(delegates)
    .set({ active: false, revokedAt: now, revokeDigest: done.digest })
    .where(
      and(
        eq(delegates.potId, a.potId),
        eq(delegates.member, m.address),
        eq(delegates.active, true),
      ),
    );
  const memoryId = await remember(
    deps,
    ns.norms(a.potId),
    "rule",
    text.delegate({ member: m.address, name: m.name, agent, cap: a.approveCap }),
  );
  await deps.db.insert(delegates).values({
    id: randomUUID(),
    potId: a.potId,
    member: m.address,
    agent,
    approveCap: a.approveCap,
    setDigest: done.digest,
    memoryId,
  });
  return { digest: done.digest, agent, approveCap: a.approveCap, memoryId };
}

/** Member: removes their delegate; from then on its calls abort onchain. */
export async function revokeDelegate(deps: ActionDeps, potId: string, member: string) {
  const m = await memberOf(deps, potId, member);
  const d = await currentDelegate(deps, potId, m.address);
  if (!d) throw new ActionError("no_delegate", "You haven't named an agent in this pot.");
  const done = await deps.chain.run(keyOf(deps, m.address), (tx) =>
    addRevokeDelegate(tx, deps.chain.packageId, deps.chain.coinType, potId),
  );
  deps.ours?.add(done.digest);
  await deps.db
    .update(delegates)
    .set({ active: false, revokedAt: deps.now?.() ?? new Date(), revokeDigest: done.digest })
    .where(eq(delegates.id, d.id));
  await remember(
    deps,
    ns.norms(potId),
    "rule",
    text.undelegate({ member: m.address, name: m.name, agent: d.agent }),
  );
  return { digest: done.digest, agent: d.agent };
}

/** The member's agent proposes a spend for them. Within its cap it carries the member's approval. */
export async function agentPropose(
  deps: ActionDeps,
  a: {
    potId: string;
    member: string;
    agent: string;
    payee: string;
    amount: bigint;
    memo: string;
    reason: string;
  },
) {
  const m = await memberOf(deps, a.potId, a.member);
  const d = await currentDelegate(deps, a.potId, m.address);
  const withinCap = !!d && same(d.agent, a.agent) && a.amount <= d.approveCap;
  const done = await deps.chain.run(agentSigner(deps, a.agent), (tx) =>
    addProposeAsDelegate(tx, deps.chain.packageId, deps.chain.coinType, {
      potId: a.potId,
      member: m.address,
      payee: a.payee,
      amount: a.amount,
      memo: a.memo,
    }),
  );
  deps.ours?.add(done.digest);
  const [last] = await deps.db
    .select()
    .from(proposals)
    .where(eq(proposals.potId, a.potId))
    .orderBy(desc(proposals.seq))
    .limit(1);
  const seq = last ? last.seq + 1 : 0;
  const agent = normalizeSuiAddress(a.agent);
  const at = (deps.now?.() ?? new Date()).toISOString();
  await deps.db.insert(proposals).values({
    potId: a.potId,
    seq,
    kind: "spend",
    payee: normalizeSuiAddress(a.payee),
    amount: a.amount,
    memo: a.memo,
    proposer: m.address,
    proposerAgent: agent,
    approvals: withinCap ? [{ member: m.address, at, agent, reason: a.reason }] : [],
    digest: done.digest,
  });
  const memoryId = await remember(
    deps,
    ns.norms(a.potId),
    "decision",
    text.agentProposed({
      seq,
      name: m.name,
      agent,
      amount: a.amount,
      memo: a.memo,
      withinCap,
      reason: a.reason,
    }),
  );
  return { seq, digest: done.digest, withinCap, memoryId };
}

/**
 * The member's agent approves for them, and runs the spend when its approval reaches the quorum.
 * Above its cap the chain aborts (`EOverDelegateCap`). With `send`, a refusal is sent anyway, so the
 * chain records it with a digest; Kitty then writes what happened to memory.
 */
export async function agentApprove(
  deps: ActionDeps,
  a: { potId: string; member: string; agent: string; seq: number; reason: string },
  send = false,
) {
  const m = await memberOf(deps, a.potId, a.member);
  const agent = normalizeSuiAddress(a.agent);
  const [p] = await deps.db
    .select()
    .from(proposals)
    .where(and(eq(proposals.potId, a.potId), eq(proposals.seq, a.seq)));
  if (!p) throw new ActionError("not_found", "No such proposal.");
  const exec = await reachesQuorum(deps, a.potId, a.seq);
  const build = (execute: boolean) => (tx: Transaction) =>
    addApproveAsDelegate(tx, deps.chain.packageId, deps.chain.coinType, {
      potId: a.potId,
      member: m.address,
      seq: a.seq,
      execute,
    });
  let done: Executed;
  try {
    done = await deps.chain.run(agentSigner(deps, agent), build(exec), send ? { send: true } : {});
  } catch (err) {
    if (err instanceof ChainAbort && err.digest) {
      await deps.db
        .update(proposals)
        .set({
          refusals: [
            ...p.refusals,
            {
              member: m.address,
              agent,
              code: err.code ?? "aborted",
              digest: err.digest,
              at: (deps.now?.() ?? new Date()).toISOString(),
              reason: a.reason,
            },
          ],
        })
        .where(and(eq(proposals.potId, a.potId), eq(proposals.seq, a.seq)));
      await remember(
        deps,
        ns.norms(a.potId),
        "decision",
        text.agentRefused({
          seq: a.seq,
          name: m.name,
          agent,
          code: err.code ?? "aborted",
          digest: err.digest,
        }),
      );
    }
    throw err;
  }
  deps.ours?.add(done.digest);
  const approvals: Approval[] = [
    ...p.approvals,
    { member: m.address, at: (deps.now?.() ?? new Date()).toISOString(), agent, reason: a.reason },
  ];
  await deps.db
    .update(proposals)
    .set({ approvals })
    .where(and(eq(proposals.potId, a.potId), eq(proposals.seq, a.seq)));
  const memoryId = await remember(
    deps,
    ns.norms(a.potId),
    "decision",
    text.agentApproved({
      seq: a.seq,
      name: m.name,
      agent,
      amount: p.amount ?? 0n,
      memo: p.memo ?? "",
      reason: a.reason,
    }),
  );
  const executed = exec ? await afterExecute(deps, a.potId, a.seq, done.digest) : null;
  return { digest: done.digest, executed: !!executed, memoryId };
}

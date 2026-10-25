// The Kitty exit (U11, ADR-0062), on testnet, in one process: the keeper, the payday stream and the API
// run here, so no second poller or server is needed. Test members are generated keys, labelled "test".
//   bun --env-file=../../.env scripts/exit.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { readFunds, tatumUsage } from "@total-recall/chain";
import { RelayerExtras } from "@total-recall/memory";
import { and, eq, isNotNull, like } from "drizzle-orm";
import {
  approve,
  createPot,
  execute,
  joinPot,
  leavePot,
  maybeSuggest,
  propose,
  spendAuto,
} from "../src/actions.ts";
import { createApp } from "../src/app.ts";
import { addSendUsdc, ChainAbort, micro, readPot, usd } from "../src/chain.ts";
import { inflows, members, memories, pots } from "../src/db/index.ts";
import { wire } from "../src/deps.ts";
import { readEnv } from "../src/env.ts";
import { onInflow, pullMember } from "../src/keeper.ts";
import { keypairFrom } from "../src/keys.ts";
import { text } from "../src/learn.ts";
import { ns } from "../src/memory.ts";
import { startWatcher } from "../src/watcher.ts";

const env = readEnv();
const logs: unknown[] = [];
const log = (msg: string, data: Record<string, unknown> = {}) => {
  logs.push({ msg, ...data });
  if (!msg.startsWith("watcher.subscribed"))
    console.log(
      "  ·",
      msg,
      JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 220),
    );
};
const w = wire(env, log);
const keeperDeps = {
  db: w.db,
  chain: w.chain,
  keeper: w.keeper,
  memory: w.memory,
  log,
  ours: w.ours,
};
const app = createApp({ ...w, keeper: w.keeper.toSuiAddress() });
const owner = keypairFrom(process.env.SPIKE_OWNER_KEY, "SPIKE_OWNER_KEY");
const ownerAddr = normalizeSuiAddress(owner.toSuiAddress());
const [A, B, C] = [...w.keys.keys()] as [string, string, string];
const out: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  members: { A, B, C },
  checks: [] as unknown[],
};
const t0 = Date.now();
/** `resume <potId>`: pick up a run that stopped after the payday transfer (re-run only the failed step). */
const resume = process.argv[2] === "resume" ? (process.argv[3] ?? null) : null;
/** With `resume`, the step to start from: 2 payday pull, 3 over-cap, 4 hotel, 5 auto-ok, 6 leave and close, 7 memories. */
const from = resume ? Number(process.argv[4] ?? 2) : 0;
out.from = from;
out.resumed = resume;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bal = (a: string) => w.chain.usdcAddressBalance(a);

function check(name: string, ok: boolean, detail: unknown = "") {
  const d = JSON.parse(
    JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ?? "null",
  );
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}`,
    typeof d === "string" ? d : JSON.stringify(d).slice(0, 400),
  );
  (out.checks as unknown[]).push({
    name,
    ok,
    detail: d,
    atSeconds: Math.round((Date.now() - t0) / 1000),
  });
  if (!ok) process.exitCode = 1;
}
async function until<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 240_000,
  every = 5_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}
async function aborts(what: string, fn: () => Promise<unknown>, code: RegExp) {
  try {
    await fn();
    check(what, false, "did not abort");
    return null;
  } catch (err) {
    const detail = err instanceof ChainAbort ? err.detail : String(err);
    check(what, code.test(detail), {
      digest: err instanceof ChainAbort ? err.digest : null,
      detail: detail.slice(0, 300),
    });
    return err instanceof ChainAbort ? err.digest : null;
  }
}

if (process.argv[2] === "overcap") {
  // Re-runs only step 3 on a fresh pot: B joins (cap $0.40), the keeper sends a $0.41 pull anyway.
  const check3 = await createPot(w, {
    creator: B,
    name: "Over-cap check (test)",
    goal: micro(1),
    deadline: new Date(Date.now() + 3600_000),
    quorum: 1,
    autoOkCap: 0n,
    windowMs: 3600_000,
    keeper: w.keeper.toSuiAddress(),
  });
  await joinPot(w, {
    potId: check3.potId,
    member: B,
    name: "Bao",
    capPerWindow: micro(0.4),
    test: true,
  });
  const potRow3 = (
    await w.db.select().from(pots).where(eq(pots.id, check3.potId))
  )[0] as typeof pots.$inferSelect;
  const b3 = (
    await w.db
      .select()
      .from(members)
      .where(and(eq(members.potId, check3.potId), eq(members.address, B)))
  )[0] as typeof members.$inferSelect;
  const bBefore = await bal(B);
  const over = await pullMember(keeperDeps, potRow3, b3, {
    force: true,
    amount: micro(0.41),
    send: true,
  });
  const bAfter = await bal(B);
  const after = await readPot(w.client, check3.potId);
  check(
    "a pull above the window's cap aborts onchain and moves nothing",
    over.status === "aborted" &&
      !!over.digest &&
      /EExceedsRateLimit/.test(over.reason) &&
      bAfter === bBefore &&
      after?.balance === 0n,
    { pot: check3.potId, digest: over.digest, error: over.reason.slice(0, 220) },
  );
  const left = await leavePot(w, check3.potId, B);
  await w.db.update(pots).set({ closed: true }).where(eq(pots.id, check3.potId));
  out.overcap = { pot: check3.potId, digest: over.digest, leave: left.digest };
  await w.memory?.flush();
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/kitty-exit-overcap.json",
    JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
  console.log(
    process.exitCode ? "EXIT FAILED" : "EXIT PASSED",
    "test-results/kitty-exit-overcap.json",
  );
  process.exit();
}
if (process.argv[2] === "aborts") {
  // Re-runs the two refusals of steps 4 and 5 as committed transactions (run 3 only saw them refused in
  // the build's simulation): a spend below quorum, and an auto-ok spend above the cap.
  const q = await createPot(w, {
    creator: A,
    name: "Abort checks (test)",
    goal: micro(1),
    deadline: new Date(Date.now() + 3600_000),
    quorum: 2,
    autoOkCap: 0n,
    windowMs: 3600_000,
    keeper: w.keeper.toSuiAddress(),
  });
  await joinPot(w, {
    potId: q.potId,
    member: A,
    name: "Ava",
    capPerWindow: micro(0.4),
    test: true,
  });
  await joinPot(w, {
    potId: q.potId,
    member: B,
    name: "Bao",
    capPerWindow: micro(0.4),
    test: true,
  });
  const qRow = (
    await w.db.select().from(pots).where(eq(pots.id, q.potId))
  )[0] as typeof pots.$inferSelect;
  const aRow = (
    await w.db
      .select()
      .from(members)
      .where(and(eq(members.potId, q.potId), eq(members.address, A)))
  )[0] as typeof members.$inferSelect;
  const pulled = await pullMember(keeperDeps, qRow, aRow, { force: true, amount: micro(0.1) });
  check("A's share lands in the check pot", pulled.status === "sent", pulled.digest);
  const sp = await propose(w, q.potId, B, {
    kind: "spend",
    payee: ownerAddr,
    amount: micro(0.05),
    memo: "hotel deposit",
  });
  const d1 = await aborts(
    "a spend below quorum aborts onchain",
    () => execute(w, q.potId, sp.seq, B, true),
    /EUnderQuorum/,
  );
  const d2 = await aborts(
    "an auto-ok spend above the cap aborts onchain",
    () =>
      spendAuto(
        w,
        { potId: q.potId, member: A, payee: ownerAddr, amount: micro(0.01), memo: "food" },
        true,
      ),
    /EOverAutoCap/,
  );
  check("both refusals are committed transactions", !!d1 && !!d2, {
    underQuorum: d1,
    overAutoCap: d2,
  });
  const after = await readPot(w.client, q.potId);
  check("nothing moved", after?.balance === micro(0.1) && after?.totalOut === 0n, {
    balance: after?.balance,
    totalOut: after?.totalOut,
  });
  const c = await propose(w, q.potId, A, { kind: "close" });
  await approve(w, q.potId, c.seq, B, true);
  await leavePot(w, q.potId, A);
  await leavePot(w, q.potId, B);
  out.aborts = { pot: q.potId, underQuorum: d1, overAutoCap: d2 };
  await w.memory?.flush();
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/kitty-exit-aborts.json",
    JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
  console.log(
    process.exitCode ? "EXIT FAILED" : "EXIT PASSED",
    "test-results/kitty-exit-aborts.json",
  );
  process.exit();
}
if (process.argv[2] === "suggest") {
  // Re-runs step 5's memory trail after ADR-0063: both joins, each approval and the suggestion are
  // memories with blobs, and the suggestion cites one.
  const q = await createPot(w, {
    creator: A,
    name: "Suggestion check (test)",
    goal: micro(1),
    deadline: new Date(Date.now() + 3600_000),
    quorum: 2,
    autoOkCap: 0n,
    windowMs: 3600_000,
    keeper: w.keeper.toSuiAddress(),
  });
  await joinPot(w, {
    potId: q.potId,
    member: A,
    name: "Ava",
    capPerWindow: micro(0.4),
    test: true,
  });
  await joinPot(w, {
    potId: q.potId,
    member: B,
    name: "Bao",
    capPerWindow: micro(0.4),
    test: true,
  });
  const qRow = (
    await w.db.select().from(pots).where(eq(pots.id, q.potId))
  )[0] as typeof pots.$inferSelect;
  const aRow = (
    await w.db
      .select()
      .from(members)
      .where(and(eq(members.potId, q.potId), eq(members.address, A)))
  )[0] as typeof members.$inferSelect;
  await pullMember(keeperDeps, qRow, aRow, { force: true, amount: micro(0.2) });
  for (const memo of ["food tacos", "food pho", "food coffee"]) {
    const f = await propose(w, q.potId, A, {
      kind: "spend",
      payee: ownerAddr,
      amount: micro(0.03),
      memo,
    });
    await approve(w, q.potId, f.seq, B, true);
  }
  const s5 = await maybeSuggest(w, q.potId);
  check("the suggestion is a memory", !!s5?.memoryId, s5);
  const stored5 = await until(
    "the suggestion's blob and both joins",
    async () => {
      const rows = await w.db
        .select()
        .from(memories)
        .where(
          and(like(memories.namespace, `kitty:pot:${q.potId}:%`), eq(memories.status, "stored")),
        );
      const has = (re: RegExp) => rows.filter((r) => re.test(r.text)).length;
      return has(/^SUGGEST /) >= 1 && has(/^JOINED /) >= 2 && has(/^APPROVED /) >= 3 ? rows : null;
    },
    300_000,
    10_000,
  );
  check(
    "both joins, three approvals and the suggestion are stored, none lost to dedupe",
    true,
    stored5.map((r) => `${r.text.slice(0, 60)} → ${r.blobId}`),
  );
  const c = await propose(w, q.potId, A, { kind: "close" });
  await approve(w, q.potId, c.seq, B, true);
  await leavePot(w, q.potId, A);
  await leavePot(w, q.potId, B);
  out.suggest = { pot: q.potId, memories: stored5.length };
  await w.memory?.flush();
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/kitty-exit-suggest.json",
    JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
  console.log(
    process.exitCode ? "EXIT FAILED" : "EXIT PASSED",
    "test-results/kitty-exit-suggest.json",
  );
  process.exit();
}
if (process.argv[2] === "api" || process.argv[2] === "web") {
  // The JSON API's test-member endpoints: propose a spend, approve it to quorum (executes), and close.
  // (On Oct 24 this mode drove the server-rendered pot page's forms; the wallet web replaced them,
  // ADR-0064, and its own run is e2e/kitty.e2e.ts.)
  const q = await createPot(w, {
    creator: A,
    name: "Web check (test)",
    goal: micro(1),
    deadline: new Date(Date.now() + 3600_000),
    quorum: 2,
    autoOkCap: 0n,
    windowMs: 3600_000,
    keeper: w.keeper.toSuiAddress(),
  });
  await joinPot(w, {
    potId: q.potId,
    member: A,
    name: "Ava",
    capPerWindow: micro(0.4),
    test: true,
  });
  await joinPot(w, {
    potId: q.potId,
    member: B,
    name: "Bao",
    capPerWindow: micro(0.4),
    test: true,
  });
  const qRow = (
    await w.db.select().from(pots).where(eq(pots.id, q.potId))
  )[0] as typeof pots.$inferSelect;
  await pullMember(
    keeperDeps,
    qRow,
    (
      await w.db
        .select()
        .from(members)
        .where(and(eq(members.potId, q.potId), eq(members.address, A)))
    )[0] as typeof members.$inferSelect,
    { force: true, amount: micro(0.1) },
  );
  const post = (path: string, body: Record<string, unknown>) =>
    app.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  const detail = await app.request(`/api/pots/${q.potId}`);
  check("the pot's detail lists its members", detail.status === 200, detail.status);
  const proposed = await post(`/api/pots/${q.potId}/proposals`, {
    kind: "spend",
    proposer: A,
    memo: "food bread",
    amountUsd: 0.04,
    payee: ownerAddr,
  });
  const before = await bal(ownerAddr);
  const approved = await post(`/api/pots/${q.potId}/proposals/0/approve`, { member: B });
  const after = await bal(ownerAddr);
  check(
    "a spend proposed and approved through the API executes at quorum",
    proposed.status === 201 && approved.status === 200 && after - before === micro(0.04),
    { paid: after - before },
  );
  const c = await propose(w, q.potId, A, { kind: "close" });
  await approve(w, q.potId, c.seq, B, true);
  await leavePot(w, q.potId, A);
  await leavePot(w, q.potId, B);
  out.web = { pot: q.potId };
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/kitty-exit-web.json",
    JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
  console.log(process.exitCode ? "EXIT FAILED" : "EXIT PASSED", "test-results/kitty-exit-web.json");
  process.exit();
}
let pot: { potId: string; digest?: string };
const potRow = async () =>
  (await w.db.select().from(pots).where(eq(pots.id, pot.potId)))[0] as typeof pots.$inferSelect;
let stopWatcher: () => void = () => {};
let paydayDigest: string;
if (resume) {
  pot = { potId: resume };
  const [row] = await w.db
    .select()
    .from(inflows)
    .where(and(eq(inflows.member, C), eq(inflows.potId, resume)));
  if (!row) throw new Error("nothing to resume: no payday inflow recorded for C in that pot");
  paydayDigest = row.digest;
} else {
  // 0. Fund the test members from the spike owner (testnet USDC): A and B $1, C only $0.05.
  const usdcOwner = await readFunds(w.client, ownerAddr, w.chain.coinType);
  out.ownerUsdc = {
    address: String(usdcOwner.addressBalance),
    coins: String(usdcOwner.coinBalance),
  };
  if (usdcOwner.addressBalance < micro(3)) {
    // "Move to address balance" (ADR-0004): merge the owner's USDC coins and send_funds them to itself.
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await w.client.core.listCoins({
        owner: ownerAddr,
        coinType: w.chain.coinType,
        ...(cursor ? { cursor } : {}),
      });
      ids.push(...page.objects.map((o) => o.objectId));
      cursor = page.hasNextPage ? page.cursor : null;
    } while (cursor);
    const moved = await w.chain.run(owner, (tx) => {
      const [first, ...rest] = ids.map((id) => tx.object(id));
      if (!first) throw new Error("the spike owner has no USDC coins to move");
      if (rest.length) tx.mergeCoins(first, rest);
      tx.moveCall({
        target: "0x2::coin::send_funds",
        typeArguments: [w.chain.coinType],
        arguments: [first, tx.pure.address(ownerAddr)],
      });
    });
    w.ours.add(moved.digest);
    await until(
      "the moved USDC to settle",
      async () => (await bal(ownerAddr)) >= micro(3),
      60_000,
      3_000,
    );
    check("the spike owner's USDC coins moved into its address balance", true, moved.digest);
  }
  const fund = await w.chain.run(owner, (tx) => {
    addSendUsdc(tx, w.chain.coinType, A, micro(1));
    addSendUsdc(tx, w.chain.coinType, B, micro(1));
    addSendUsdc(tx, w.chain.coinType, C, micro(0.05));
  });
  w.ours.add(fund.digest);
  check("test members funded (A $1, B $1, C $0.05)", true, fund.digest);

  // 1. Create "Da Lat trip" and join with one signature each (C through the web form).
  const deadline = new Date(Date.now() + 3 * 3600_000);
  pot = await createPot(w, {
    creator: A,
    name: "Da Lat trip (test)",
    goal: micro(1.5),
    deadline,
    quorum: 2,
    autoOkCap: 0n,
    windowMs: 3600_000,
    keeper: w.keeper.toSuiAddress(),
  });
  out.pot = pot;
  check("pot created on testnet", !!pot.potId, pot);
  await w.memory?.remember(
    ns.members(pot.potId),
    "episode",
    text.created({
      potId: pot.potId,
      name: "Da Lat trip (test)",
      goal: micro(1.5),
      deadline,
      quorum: 2,
      members: "Ava, Bao, Chi (test)",
    }),
  );
  const ja = await joinPot(w, {
    potId: pot.potId,
    member: A,
    name: "Ava",
    capPerWindow: micro(0.4),
    test: true,
  });
  const jb = await joinPot(w, {
    potId: pot.potId,
    member: B,
    name: "Bao",
    capPerWindow: micro(0.4),
    test: true,
  });
  const jc = await app.request(`/api/pots/${pot.potId}/join`, {
    method: "POST",
    body: JSON.stringify({ member: C, name: "Chi", capUsd: 0.4 }),
    headers: { "content-type": "application/json" },
  });
  const ms = await w.db.select().from(members).where(eq(members.potId, pot.potId));
  check(
    "three members joined with one signature each (C through the API)",
    ms.length === 3 && jc.status === 201,
    { A: ja.digest, B: jb.digest, C: ms.find((m) => m.address === C)?.joinDigest },
  );
  out.joins = ms.map((m) => ({ name: m.name, allowance: m.allowanceId, digest: m.joinDigest }));

  // The payday stream, filtered to the three members (ADR-0058).
  stopWatcher = startWatcher({
    client: w.client,
    coinType: w.chain.coinType,
    log,
    refreshMs: 15_000,
    addresses: async () =>
      (
        await w.db
          .select()
          .from(members)
          .where(and(eq(members.potId, pot.potId), eq(members.active, true)))
      ).map((m) => m.address),
    onInflow: (i, cp) => onInflow(keeperDeps, i.address, i.amount, i.digest, cp),
  });
  await sleep(8_000);

  // 2. Pulls: A and B land; C is short, so no transaction and a memory.
  const p0 = await potRow();
  const row0 = async (a: string) =>
    (
      await w.db
        .select()
        .from(members)
        .where(and(eq(members.potId, pot.potId), eq(members.address, a)))
    )[0] as typeof members.$inferSelect;
  const pa = await pullMember(keeperDeps, p0, await row0(A));
  const pb = await pullMember(keeperDeps, p0, await row0(B));
  const pc = await pullMember(keeperDeps, p0, await row0(C));
  out.share = usd(pa.amount);
  check("two pulls land", pa.status === "sent" && pb.status === "sent", {
    A: pa.digest,
    B: pb.digest,
    amount: pa.amount,
  });
  check(
    "the short member is skipped with no transaction, and a memory",
    pc.status === "skipped" && !pc.digest && !!pc.memoryId,
    pc.reason,
  );
  out.pulls = { A: pa, B: pb, Cskipped: pc };

  // Payday: the spike owner pays C; the stream sees it; the pull follows and cites the memory.
  const payday = await w.chain.run(owner, (tx) => addSendUsdc(tx, w.chain.coinType, C, micro(0.5)));
  check("C's payday transfer", true, payday.digest);
  paydayDigest = payday.digest;
}
const p = await potRow();
const memberRow = async (a: string) =>
  (
    await w.db
      .select()
      .from(members)
      .where(and(eq(members.potId, pot.potId), eq(members.address, a)))
  )[0] as typeof members.$inferSelect;
if (from <= 2) {
  const seen = await until(
    "the stream to see C's payday",
    async () => {
      const [row] = await w.db
        .select()
        .from(inflows)
        .where(and(eq(inflows.member, C), eq(inflows.digest, paydayDigest)));
      // The row lands first and its memory id right after; wait for both.
      return row?.memoryId ? row : null;
    },
    180_000,
    3_000,
  );
  check("the filtered stream saw the payday", true, {
    checkpoint: seen.checkpoint,
    memoryId: seen.memoryId,
  });
  await until(
    "the payday memory's blob",
    async () => {
      const [row] = await w.db
        .select()
        .from(memories)
        .where(and(eq(memories.id, seen.memoryId ?? ""), isNotNull(memories.blobId)));
      return row ?? null;
    },
    240_000,
    5_000,
  );
  const pc2 = await pullMember(keeperDeps, p, await memberRow(C));
  check(
    "C is pulled right after payday, citing the memory",
    pc2.status === "sent" && /payday/.test(pc2.reason) && pc2.memoryId === seen.memoryId,
    { digest: pc2.digest, reason: pc2.reason },
  );
  out.paydayPull = pc2;
}
if (from <= 3) {
  // 3. A deliberate pull above the window's cap aborts onchain; nothing moves.
  const bBefore = await bal(B);
  const potBefore = await readPot(w.client, pot.potId);
  const over = await pullMember(keeperDeps, p, await memberRow(B), {
    force: true,
    amount: micro(0.41),
    send: true,
  });
  const bAfter = await bal(B);
  const potAfter = await readPot(w.client, pot.potId);
  check(
    "a pull above the window's cap aborts onchain and moves nothing",
    over.status === "aborted" &&
      !!over.digest &&
      /EExceedsRateLimit|rate/i.test(over.reason) &&
      bAfter === bBefore &&
      potAfter?.balance === potBefore?.balance,
    { digest: over.digest, error: over.reason.slice(0, 200) },
  );
}
if (from <= 4) {
  // 4. "Hotel": under quorum, execute aborts; with a second approval it executes and pays.
  const hotel = await propose(w, pot.potId, B, {
    kind: "spend",
    payee: ownerAddr,
    amount: micro(0.2),
    memo: "hotel one night",
  });
  await aborts(
    "a spend below quorum aborts",
    () => execute(w, pot.potId, hotel.seq, B, true),
    /EUnderQuorum/,
  );
  const payeeBefore = await bal(ownerAddr);
  const hotelDone = await approve(w, pot.potId, hotel.seq, C, true);
  const payeeAfter = await bal(ownerAddr);
  check(
    "with two approvals the spend executes and pays the payee",
    payeeAfter - payeeBefore === micro(0.2),
    { digest: hotelDone.digest, paid: payeeAfter - payeeBefore },
  );
}
if (from <= 5) {
  // 5. Three quick food spends → Kitty suggests an auto-ok cap → the group votes it → inside passes, above aborts.
  for (const memo of ["food tacos", "food pho", "food coffee"]) {
    const f = await propose(w, pot.potId, A, {
      kind: "spend",
      payee: ownerAddr,
      amount: micro(0.03),
      memo,
    });
    await approve(w, pot.potId, f.seq, B, true);
  }
  const suggestion = await maybeSuggest(w, pot.potId);
  check(
    "Kitty suggests an auto-ok rule from how the group approves",
    !!suggestion && suggestion.category === "food" && suggestion.cap === micro(0.05),
    suggestion,
  );
  const vote = await propose(w, pot.potId, A, {
    kind: "auto_cap",
    cap: suggestion?.cap ?? micro(0.05),
  });
  const voted = await approve(w, pot.potId, vote.seq, B, true);
  const onchain = await readPot(w.client, pot.potId);
  check("the group voted the rule in, onchain", onchain?.autoOkCap === micro(0.05), {
    digest: voted.digest,
    autoOkCap: onchain?.autoOkCap,
  });
  const inside = await spendAuto(w, {
    potId: pot.potId,
    member: A,
    payee: ownerAddr,
    amount: micro(0.04),
    memo: "food snacks",
  });
  check("an auto-ok spend inside the cap passes", !!inside.digest, inside.digest);
  await aborts(
    "an auto-ok spend above the cap aborts",
    () =>
      spendAuto(
        w,
        { potId: pot.potId, member: A, payee: ownerAddr, amount: micro(0.06), memo: "food dinner" },
        true,
      ),
    /EOverAutoCap/,
  );
}
if (from <= 6) {
  // 6. C leaves: no more pulls. Then close by vote: pro-rata refunds, and the sums balance.
  const left = await leavePot(w, pot.potId, C);
  const allowanceGone =
    (await w.client.core
      .getObject({ objectId: (await memberRow(C)).allowanceId })
      .catch(() => null)) === null;
  const nextC = await pullMember(keeperDeps, await potRow(), await memberRow(C), { force: true });
  check(
    "a member who left can't be pulled (allowance revoked)",
    allowanceGone && nextC.status === "not_due",
    { digest: left.digest, keeper: nextC.reason },
  );
  const beforeClose = await readPot(w.client, pot.potId);
  const balancesBefore = await Promise.all([A, B, C].map(bal));
  const close = await propose(w, pot.potId, A, { kind: "close" });
  const closed = await approve(w, pot.potId, close.seq, B, true);
  const afterClose = await readPot(w.client, pot.potId);
  const balancesAfter = await Promise.all([A, B, C].map(bal));
  const refunded = balancesAfter.reduce((s, x, i) => s + x - (balancesBefore[i] as bigint), 0n);
  const sums = {
    totalIn: afterClose?.totalIn,
    totalOut: afterClose?.totalOut,
    refunded,
    potBefore: beforeClose?.balance,
    potAfter: afterClose?.balance,
  };
  check(
    "close refunds pro rata and the sums balance",
    !!afterClose?.closed &&
      afterClose.balance === 0n &&
      refunded === beforeClose?.balance &&
      afterClose.totalIn === afterClose.totalOut + refunded,
    { digest: closed.digest, ...sums },
  );
  out.sums = sums;
  stopWatcher();
}
// 7. Memories: ≥10 in kitty:pot:<id>:*, stored on the mainnet relayer, shown on the learned page.
const stored = await until(
  "≥10 stored kitty memories",
  async () => {
    const rows = await w.db
      .select()
      .from(memories)
      .where(
        and(like(memories.namespace, `kitty:pot:${pot.potId}:%`), eq(memories.status, "stored")),
      );
    return rows.length >= 10 ? rows : null;
  },
  300_000,
  10_000,
);
const relayer = new RelayerExtras({
  key: env.MEMWAL_PRIVATE_KEY as string,
  accountId: env.MEMWAL_ACCOUNT_ID as string,
  serverUrl: env.MEMWAL_SERVER_URL,
});
const counts: Record<string, number> = {};
for (const n of [ns.members(pot.potId), ns.norms(pot.potId)])
  counts[n] = (await relayer.stats(n)).memory_count;
check(
  "≥10 kitty memories on the mainnet relayer",
  Object.values(counts).reduce((s, x) => s + x, 0) >= 10,
  { indexedStored: stored.length, relayer: counts },
);
const learned = await app.request(`/api/pots/${pot.potId}/memories`);
const learnedRows = (await learned.json()) as { blobId: string | null }[];
check(
  "the learned memories are served, each with its blob",
  learned.status === 200 && learnedRows.filter((r) => r.blobId).length >= 10,
  { status: learned.status },
);
const page = await app.request(`/api/pots/${pot.potId}`);
check("the pot's detail is served", page.status === 200, page.status);

await w.memory?.flush();
out.tatumUsage = tatumUsage();
out.seconds = Math.round((Date.now() - t0) / 1000);
out.finishedAt = new Date().toISOString();
mkdirSync("test-results", { recursive: true });
writeFileSync(
  "test-results/kitty-exit.json",
  JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
);
console.log(
  process.exitCode ? "EXIT FAILED" : "EXIT PASSED",
  "test-results/kitty-exit.json",
  `${out.seconds}s`,
);
process.exit();

/**
 * What Kitty learns (KT2, ADR-0062), as memory text it writes and parses back.
 * - **Members:** paydays (inflows the stream saw), skips (a share the balance couldn't cover), and
 *   adaptations (a member behind plan).
 * - **Norms:** each executed spend with how fast it was approved, and the auto-ok rule it suggests.
 */

export interface SpendNorm {
  category: string;
  amount: bigint;
  minutes: number;
  approvals: number;
}

/** "Food 3 tacos" → "food". The first word of the memo is the category. */
export const categoryOf = (memo: string) =>
  (memo.trim().split(/\s+/)[0] ?? "other").toLowerCase().replace(/[^a-z]/g, "") || "other";

export const SUGGEST_MIN_SPENDS = 3;
export const SUGGEST_MAX_MINUTES = 10;
/** Suggested caps round up to this step (micro-USDC): $0.05. */
export const SUGGEST_STEP = 50_000n;

/**
 * An auto-ok cap the group has already been acting out: at least 3 spends of one category, each
 * approved within 10 minutes. The cap is the largest of them, rounded up to the next $0.05.
 */
export function suggestAutoOk(
  history: SpendNorm[],
  currentCap: bigint,
): { category: string; cap: bigint; n: number } | null {
  const byCategory = new Map<string, SpendNorm[]>();
  for (const h of history) byCategory.set(h.category, [...(byCategory.get(h.category) ?? []), h]);
  let best: { category: string; cap: bigint; n: number } | null = null;
  for (const [category, list] of byCategory) {
    const quick = list.filter((h) => h.minutes <= SUGGEST_MAX_MINUTES);
    if (quick.length < SUGGEST_MIN_SPENDS) continue;
    const max = quick.reduce((m, h) => (h.amount > m ? h.amount : m), 0n);
    const cap = ((max + SUGGEST_STEP - 1n) / SUGGEST_STEP) * SUGGEST_STEP;
    if (cap <= currentCap) continue;
    if (!best || quick.length > best.n) best = { category, cap, n: quick.length };
  }
  return best;
}

export interface ShareInput {
  goal: bigint;
  totalIn: bigint;
  deadlineMs: number;
  windowMs: number;
  nowMs: number;
  activeMembers: number;
  capPerWindow: bigint;
  contributed: bigint;
}

/**
 * A member's pull: their fair share of what's left over the windows left, raised if they're behind
 * plan, never above their cap per window.
 */
export function shareFor(s: ShareInput): { amount: bigint; behind: bigint } {
  if (s.activeMembers <= 0 || s.totalIn >= s.goal) return { amount: 0n, behind: 0n };
  const windowsLeft = BigInt(Math.max(1, Math.ceil((s.deadlineMs - s.nowMs) / s.windowMs)));
  const n = BigInt(s.activeMembers);
  const fair = (s.goal - s.totalIn + windowsLeft * n - 1n) / (windowsLeft * n);
  // Behind: what an even split would have them at by now, minus what they put in.
  const perMember = s.goal / n;
  const expected = perMember - perMember / (windowsLeft + 1n);
  const behind = expected > s.contributed ? expected - s.contributed : 0n;
  const want = fair + (behind > 0n ? behind / windowsLeft : 0n);
  return { amount: want < s.capPerWindow ? want : s.capPerWindow, behind };
}

const usd = (micro: bigint) => `$${(Number(micro) / 1e6).toFixed(2)}`;

export const text = {
  created: (o: {
    potId: string;
    name: string;
    goal: bigint;
    deadline: Date;
    quorum: number;
    members: string;
  }) =>
    `POT created pot=${o.potId} "${o.name}" goal=${usd(o.goal)} deadline=${o.deadline.toISOString().slice(0, 16)}Z quorum=${o.quorum} members: ${o.members}`,
  joined: (o: { member: string; name: string; cap: bigint; windowMs: number }) =>
    `JOINED member=${o.member} (${o.name}) cap=${usd(o.cap)} per ${Math.round(o.windowMs / 60_000)} min, one signature; the money stays in their balance until a pull`,
  skip: (o: { member: string; name: string; balance: bigint; share: bigint; at: Date }) =>
    `SKIP member=${o.member} (${o.name}) on ${o.at.toISOString().slice(0, 16)}Z: balance ${usd(o.balance)} < share ${usd(o.share)}, so no transaction and no fee; next pull waits for an inflow (payday)`,
  payday: (o: { member: string; name: string; amount: bigint; at: Date; digest: string }) =>
    `PAYDAY member=${o.member} (${o.name}) received ${usd(o.amount)} on ${o.at.toISOString().slice(0, 16)}Z (day ${o.at.getUTCDate()} of the month, ${o.digest.slice(0, 10)}…); pull right after payday`,
  pulled: (o: { member: string; name: string; amount: bigint; why: string }) =>
    `PULLED member=${o.member} (${o.name}) ${usd(o.amount)} ${o.why}`,
  behind: (o: { member: string; name: string; behind: bigint; amount: bigint }) =>
    `BEHIND member=${o.member} (${o.name}) is ${usd(o.behind)} behind plan; this window's pull rises to ${usd(o.amount)} (still within their cap)`,
  approved: (o: {
    seq: number;
    category: string;
    amount: bigint;
    minutes: number;
    approvals: number;
  }) =>
    `APPROVED proposal=${o.seq} category=${o.category} amount=${usd(o.amount)} within ${o.minutes} min by ${o.approvals} members`,
  suggest: (o: { category: string; cap: bigint; n: number }) =>
    `SUGGEST auto-ok up to ${usd(o.cap)}: the group approved ${o.n} ${o.category} spends under it, each within ${SUGGEST_MAX_MINUTES} min`,
  rule: (o: { cap: bigint; seq: number; approvals: number }) =>
    `RULE auto-ok cap is now ${usd(o.cap)}, voted by ${o.approvals} members (proposal ${o.seq}); the contract enforces it`,
  left: (o: { member: string; name: string; contributed: bigint }) =>
    `LEFT member=${o.member} (${o.name}) revoked their allowance; no more pulls. ${usd(o.contributed)} they put in stays until close`,
  closed: (o: { refunded: bigint; totalIn: bigint; totalOut: bigint }) =>
    `CLOSED refunded ${usd(o.refunded)} pro rata; in ${usd(o.totalIn)}, spent ${usd(o.totalOut)}`,
};

export function parsePayday(t: string) {
  const m =
    /PAYDAY member=(\S+) \(([^)]*)\) received \$([\d.]+) on (\S+) \(day (\d+) of the month/.exec(t);
  return m
    ? {
        member: m[1] as string,
        name: m[2] as string,
        amount: Number(m[3]),
        at: m[4] as string,
        day: Number(m[5]),
      }
    : null;
}

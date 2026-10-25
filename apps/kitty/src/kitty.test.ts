import { Transaction } from "@mysten/sui/transactions";
import { describe, expect, it } from "vitest";
import { addContribute, addJoin, addPropose, micro, usd } from "./chain.ts";
import { categoryOf, parsePayday, shareFor, suggestAutoOk, text } from "./learn.ts";
import { filterFor, inflowsFrom } from "./watcher.ts";

const USDC = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const PKG = "0xcd3889825bd9c444b4ef1b9846d84777784292546e83bec3c883ae89ff30d056";
const addr = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

describe("shares", () => {
  const base = {
    goal: micro(1.5),
    totalIn: 0n,
    deadlineMs: 3 * 3600_000,
    windowMs: 3600_000,
    nowMs: 0,
    activeMembers: 3,
    capPerWindow: micro(0.4),
    contributed: 0n,
  };
  it("splits what's left over the windows left and the members", () => {
    expect(shareFor(base).amount).toBeGreaterThanOrEqual(micro(0.5) / 3n);
  });
  it("never asks for more than the member's cap", () => {
    expect(shareFor({ ...base, goal: micro(100) }).amount).toBe(micro(0.4));
  });
  it("asks nothing once the goal is met, or with nobody left", () => {
    expect(shareFor({ ...base, totalIn: micro(1.5) }).amount).toBe(0n);
    expect(shareFor({ ...base, activeMembers: 0 }).amount).toBe(0n);
  });
  it("raises the share of a member who is behind plan", () => {
    const late = { ...base, nowMs: 2 * 3600_000, totalIn: micro(0.6) };
    const behind = shareFor({ ...late, contributed: 0n });
    const onPlan = shareFor({ ...late, contributed: micro(0.4) });
    expect(behind.behind).toBeGreaterThan(0n);
    expect(behind.amount).toBeGreaterThanOrEqual(onPlan.amount);
  });
});

describe("suggested rules", () => {
  const spend = (category: string, dollars: number, minutes: number) => ({
    category,
    amount: micro(dollars),
    minutes,
    approvals: 2,
  });
  it("suggests a cap after three quick spends of one kind, rounded up to $0.05", () => {
    const s = suggestAutoOk(
      [spend("food", 0.03, 1), spend("food", 0.03, 2), spend("food", 0.03, 0)],
      0n,
    );
    expect(s).toEqual({ category: "food", cap: micro(0.05), n: 3 });
  });
  it("ignores slow approvals, other kinds, and caps the group already has", () => {
    expect(
      suggestAutoOk([spend("food", 0.03, 1), spend("food", 0.03, 30), spend("hotel", 0.2, 1)], 0n),
    ).toBeNull();
    expect(
      suggestAutoOk(
        [spend("food", 0.03, 1), spend("food", 0.03, 1), spend("food", 0.03, 1)],
        micro(0.05),
      ),
    ).toBeNull();
  });
  it("reads the category from the memo's first word", () => {
    expect(categoryOf("Food: tacos")).toBe("food");
    expect(categoryOf("  hotel one night")).toBe("hotel");
    expect(categoryOf("")).toBe("other");
  });
});

describe("memory text", () => {
  it("round-trips a payday", () => {
    const t = text.payday({
      member: addr(1),
      name: "Chi",
      amount: micro(0.5),
      at: new Date("2026-10-25T08:00:00Z"),
      digest: "C9w6ggoDKHj1PoxB",
    });
    expect(parsePayday(`[profile] [by:@kitty] [2026-10-25] ${t}`)).toMatchObject({
      name: "Chi",
      amount: 0.5,
      day: 25,
    });
  });
  it("says why a skip costs nothing", () => {
    expect(
      text.skip({
        member: addr(1),
        name: "Chi",
        balance: micro(0.05),
        share: micro(0.23),
        at: new Date(),
      }),
    ).toMatch(/balance \$0\.05 < share \$0\.23, so no transaction and no fee/);
    expect(usd(1_234_567n)).toBe("$1.23");
  });
});

describe("the payday stream", () => {
  it("filters by address, at most 10", () => {
    expect(filterFor([addr(1), addr(2)]).terms).toHaveLength(2);
    expect(() => filterFor(Array.from({ length: 11 }, (_, i) => addr(i + 1)))).toThrow();
  });
  it("keeps only USDC arriving at a watched address", () => {
    const cp = {
      transactions: [
        {
          digest: "d1",
          balanceChanges: [
            { address: addr(1), coinType: USDC, amount: "500000" },
            { address: addr(1), coinType: "0x2::sui::SUI", amount: "9" },
            { address: addr(2), coinType: USDC, amount: "-500000" },
            { address: addr(3), coinType: USDC, amount: "7" },
          ],
        },
      ],
    };
    expect(inflowsFrom(cp, new Set([addr(1), addr(2)]), USDC)).toEqual([
      { address: addr(1), amount: 500000n, digest: "d1" },
    ]);
  });
});

describe("transactions", () => {
  const calls = (tx: Transaction) =>
    tx
      .getData()
      .commands.map((c) =>
        c.$kind === "MoveCall" ? `${c.MoveCall.module}::${c.MoveCall.function}` : c.$kind,
      );
  it("joins with one PTB: the rate limit, the proposal, then the pot", () => {
    const tx = new Transaction();
    addJoin(tx, PKG, USDC, {
      potId: addr(9),
      allowanceName: "kitty:x",
      keeper: addr(8),
      capPerWindow: micro(0.4),
      windowMs: 3600_000,
      expiryMs: 1,
    });
    expect(calls(tx)).toEqual([
      "allowance::periodic_rate_limit",
      "option::some",
      "allowance::propose_for_app",
      "pot::join",
    ]);
  });
  it("pulls through the allowance and proposes by kind", () => {
    const tx = new Transaction();
    addContribute(tx, PKG, USDC, {
      potId: addr(9),
      allowanceId: addr(7),
      member: addr(1),
      amount: 1n,
    });
    addPropose(tx, PKG, USDC, addr(9), { kind: "auto_cap", cap: micro(0.05) });
    addPropose(tx, PKG, USDC, addr(9), { kind: "close" });
    expect(calls(tx)).toEqual([
      "pot::contribute",
      "pot::propose_auto_ok_cap",
      "pot::propose_close",
    ]);
  });
});

/**
 * The wallet web, end to end on testnet (ADR-0064). Kitty's generated test members sign with an
 * injected wallet; every transaction is sponsored.
 * 1. Ava's wallet starts a "(test)" pot and joins it, one signature each.
 * 2. Bao's wallet joins from the pot page.
 * 3. The keeper pulls Ava's share (server side, as in the exit script).
 * 4. Ava proposes a spend; Bao's approval reaches quorum and pays it in the same transaction.
 * 5. Chi gets a USDC coin and moves it into his balance from the "Get ready" card.
 * 6. Ava leaves.
 * The digests go to test-results/kitty-e2e.json; screenshots to test-results/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Keypair } from "@mysten/sui/cryptography";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { micro } from "../src/chain.ts";
import { members, pots } from "../src/db/index.ts";
import { wire } from "../src/deps.ts";
import { readEnv } from "../src/env.ts";
import { pullMember } from "../src/keeper.ts";
import { keypairFrom } from "../src/keys.ts";
import { connect, installTestWallet } from "./test-wallet.ts";

const env = readEnv();
const w = wire(env, () => {});
const keys = (env.KITTY_MEMBER_KEYS ?? "").split(",").filter(Boolean);
const [ava, bao, chi] = keys.map((k) => keypairFrom(k, "KITTY_MEMBER_KEYS")) as [
  Keypair,
  Keypair,
  Keypair,
];
const results = resolve(import.meta.dirname, "../test-results");
const out: Record<string, unknown> = { startedAt: new Date().toISOString() };

async function walletPage(browser: Browser, kp: Keypair, name: string, path: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await installTestWallet(page, kp, name, w.client);
  await page.goto(path);
  await connect(page, name);
  return page;
}

/** Clicks, and returns what `/api/tx/execute` answered once the wallet signed. */
async function signed<T = { digest: string }>(page: Page, click: () => Promise<void>): Promise<T> {
  const res = page.waitForResponse(
    (r) => r.url().endsWith("/api/tx/execute") && r.request().method() === "POST",
    { timeout: 180_000 },
  );
  await click();
  const r = await res;
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as T;
}

async function memberRow(potId: string, address: string) {
  const [row] = await w.db
    .select()
    .from(members)
    .where(and(eq(members.potId, potId), eq(members.address, normalizeSuiAddress(address))));
  return row;
}

test.afterAll(() => {
  out.finishedAt = new Date().toISOString();
  mkdirSync(results, { recursive: true });
  writeFileSync(`${results}/kitty-e2e.json`, JSON.stringify(out, null, 2));
});

test("members run a pot from their own wallets", async ({ browser }) => {
  test.skip(!ava || !bao || !chi, "needs KITTY_MEMBER_KEYS (three generated test keys)");
  const AVA = "Kitty test wallet (Ava)";
  const BAO = "Kitty test wallet (Bao)";
  const CHI = "Kitty test wallet (Chi)";
  let potId = "";
  let a: Page;

  await test.step("Ava starts a pot with one signature", async () => {
    a = await walletPage(browser, ava, AVA, "/");
    await a.getByRole("button", { name: "Start a pot" }).click();
    const stamp = new Date().toISOString().slice(5, 16).replace("T", " ");
    await a.getByLabel("Name").fill(`Wallet web check ${stamp} (test)`);
    await a.getByLabel("Goal ($)").fill("1");
    await a.getByLabel("Approvals to spend").fill("2");
    await a.getByLabel("Kitty pulls each share").selectOption("60");
    const created = await signed<{ potId: string; digest: string }>(a, () =>
      a.getByRole("button", { name: "Create the pot" }).click(),
    );
    await a.waitForURL(/\/pots\/0x[0-9a-f]{64}\?created=/);
    potId = created.potId;
    out.pot = potId;
    out.create = created.digest;
    await expect(a.getByText("Your pot is on Sui.")).toBeVisible();
  });

  await test.step("Ava joins with one signature", async () => {
    await a.getByLabel("Your name").fill("Ava");
    const joined = await signed(a, () =>
      a.getByRole("button", { name: "Join with one signature" }).click(),
    );
    await expect(a.getByText("You're in as Ava")).toBeVisible();
    expect((await memberRow(potId, ava.toSuiAddress()))?.test).toBe(true);
    out.joinAva = joined.digest;
  });

  const b = await walletPage(browser, bao, BAO, `/pots/${potId}`);
  await test.step("Bao joins from the pot page", async () => {
    await b.getByLabel("Your name").fill("Bao");
    const joined = await signed(b, () =>
      b.getByRole("button", { name: "Join with one signature" }).click(),
    );
    await expect(b.getByText("You're in as Bao")).toBeVisible();
    out.joinBao = joined.digest;
  });

  await test.step("the keeper pulls Ava's share", async () => {
    const [pot] = await w.db.select().from(pots).where(eq(pots.id, potId));
    const m = await memberRow(potId, ava.toSuiAddress());
    if (!pot || !m) throw new Error("pot or member missing");
    const pulled = await pullMember(
      { db: w.db, chain: w.chain, keeper: w.keeper, memory: w.memory, ours: w.ours },
      pot,
      m,
      { force: true, amount: micro(0.1) },
    );
    expect(pulled.status).toBe("sent");
    out.pull = pulled.digest;
  });

  const payee = normalizeSuiAddress(chi.toSuiAddress());
  await test.step("Ava proposes a spend; Bao's approval reaches quorum and pays it", async () => {
    await a.reload();
    await a.getByRole("button", { name: "Propose a spend" }).click();
    await a.getByLabel("What for").fill("food snacks");
    await a.getByLabel("Amount ($)").fill("0.05");
    await a.getByLabel("Pay to (Sui address)").fill(payee);
    const proposed = await signed<{ seq: number; digest: string }>(a, () =>
      a.getByRole("button", { name: "Propose it" }).click(),
    );
    await expect(a.getByText("food snacks: $0.05")).toBeVisible();
    out.propose = proposed.digest;
    const before = await w.chain.usdcAddressBalance(payee);
    await b.reload();
    const paid = await signed(b, () => b.getByRole("button", { name: "Approve and pay" }).click());
    await expect(b.getByText("done", { exact: true })).toBeVisible();
    out.approveAndPay = paid.digest;
    let after = before;
    for (let i = 0; i < 20 && after - before < micro(0.05); i++) {
      await new Promise((r) => setTimeout(r, 3_000));
      after = await w.chain.usdcAddressBalance(payee);
    }
    expect(after - before).toBe(micro(0.05));
    out.paid = String(after - before);
  });

  await test.step("screenshots: the pot page on desktop and at phone width", async () => {
    mkdirSync(results, { recursive: true });
    await a.reload();
    await expect(a.getByText("You're in as Ava")).toBeVisible();
    await a.screenshot({ path: `${results}/kitty-pot-desktop.png`, fullPage: true });
    await b.setViewportSize({ width: 375, height: 812 });
    await b.reload();
    await expect(b.getByText("You're in as Bao")).toBeVisible();
    await b.screenshot({ path: `${results}/kitty-pot-375.png`, fullPage: true });
    await b.goto(`/pots/${potId}/learned`);
    await expect(b.getByRole("heading", { name: "What Kitty learned" })).toBeVisible();
    await b.screenshot({ path: `${results}/kitty-learned-375.png`, fullPage: true });
  });

  await test.step("Chi moves a USDC coin into his balance from the Get ready card", async () => {
    const owner = keypairFrom(process.env.SPIKE_OWNER_KEY, "SPIKE_OWNER_KEY");
    const gift = await w.chain.run(owner, (tx) => {
      const coin = tx.moveCall({
        target: "0x2::coin::redeem_funds",
        typeArguments: [w.chain.coinType],
        arguments: [tx.withdrawal({ amount: micro(0.05), type: w.chain.coinType })],
      });
      tx.transferObjects([coin], payee);
    });
    out.coinGift = gift.digest;
    const c = await walletPage(browser, chi, CHI, "/");
    const move = c.getByRole("button", { name: /^Move \$0\.\d\d to my balance$/ });
    await expect(move).toBeVisible();
    await c.screenshot({ path: `${results}/kitty-home-get-ready.png`, fullPage: true });
    const moved = await signed(c, () => move.click());
    await expect(c.getByText("Moved into your balance.")).toBeVisible();
    out.deposit = moved.digest;
  });

  await test.step("Ava leaves", async () => {
    await a.getByRole("button", { name: "Leave…" }).click();
    const left = await signed(a, () => a.getByRole("button", { name: "Leave the pot" }).click());
    await expect(a.getByText("You left this pot.")).toBeVisible();
    const m = await memberRow(potId, ava.toSuiAddress());
    expect(m?.active).toBe(false);
    out.leave = left.digest;
  });
});

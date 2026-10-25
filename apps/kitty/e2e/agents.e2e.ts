/**
 * The U12 exit for Kitty (KT4, ADR-0067), on testnet. An agent with a mandate:
 * 1. A fresh "(test)" pot: Ava, Bao and Chi join (the keys Kitty holds for labelled test members), and
 *    the keeper pulls $0.15 each from Ava and Bao.
 * 2. Bao's wallet (an injected test wallet) names the treasurer agent with a $0.10 cap, onchain.
 * 3. Ava proposes $0.05 of food. The treasurer (an OpenRouter model, through the stdio MCP server that
 *    holds its key) approves it for Bao, and the spend executes at quorum. Its reason cites a memory blob.
 * 4. Ava proposes a $0.20 hotel deposit. The treasurer's model decides, and a FORCED approval through
 *    its key then aborts onchain (EOverDelegateCap, a committed failed transaction). Bao approves it in
 *    the web, and it's paid.
 * 5. Bao revokes the agent in the web. A forced approval of a new spend aborts onchain (ENotDelegate).
 * Digests, blobs, the model's decisions and timings go to test-results/kitty-u12-exit.json; screenshots
 * to test-results/u12/.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Keypair } from "@mysten/sui/cryptography";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { and, eq, isNotNull } from "drizzle-orm";
import { micro } from "../src/chain.ts";
import { delegates, members, memories, pots, proposals } from "../src/db/index.ts";
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
const agentKey = process.env.KITTY_AGENT_KEY;
const AGENT = agentKey
  ? normalizeSuiAddress(keypairFrom(agentKey, "KITTY_AGENT_KEY").toSuiAddress())
  : "";
const API = "http://localhost:8821";
const app = resolve(import.meta.dirname, "..");
const results = resolve(app, "test-results");
const shots = resolve(results, "u12");
const out: Record<string, unknown> = { startedAt: new Date().toISOString(), agent: AGENT };
const timings: Record<string, number> = {};

async function timed<T>(name: string, f: () => Promise<T>): Promise<T> {
  const t = Date.now();
  try {
    return await f();
  } finally {
    timings[name] = Math.round((Date.now() - t) / 100) / 10;
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { message?: string };
  if (!res.ok) throw new Error(`${path}: ${res.status} ${json.message ?? ""}`);
  return json;
}

/** Runs the treasurer agent once and returns its JSON line. */
function treasurer(args: string[]) {
  const r = spawnSync("bun", ["agents/treasurer/index.ts", ...args], {
    cwd: app,
    env: { ...process.env, KITTY_API_URL: API },
    encoding: "utf8",
    timeout: 240_000,
  });
  const line = r.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}";
  const parsed = JSON.parse(line) as Record<string, unknown>;
  if (parsed.error) throw new Error(`treasurer: ${parsed.error}\n${r.stderr}`);
  return parsed;
}

async function walletPage(browser: Browser, kp: Keypair, name: string, path: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  await installTestWallet(page, kp, name, w.client);
  await page.goto(path);
  await connect(page, name);
  return page;
}

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

async function failedOnchain(digest: string, code: string) {
  const res = await w.client.core.getTransaction({ digest, include: { effects: true } });
  const t = res.Transaction ?? res.FailedTransaction;
  expect(t?.effects?.status.success).toBe(false);
  expect(JSON.stringify(t?.effects?.status.error)).toContain(code);
}

const recorded = (result: unknown) => /Recorded onchain: (\w{40,50})/.exec(String(result))?.[1];

test.afterAll(() => {
  out.timings = timings;
  out.finishedAt = new Date().toISOString();
  mkdirSync(results, { recursive: true });
  writeFileSync(`${results}/kitty-u12-exit.json`, JSON.stringify(out, null, 2));
});

test("an agent with a mandate: within its cap it acts, above it the chain refuses", async ({
  browser,
}) => {
  test.skip(!ava || !bao || !chi || !AGENT, "needs KITTY_MEMBER_KEYS and KITTY_AGENT_KEY");
  test.setTimeout(30 * 60_000);
  const BAO = "Kitty test wallet (Bao)";
  const payee = normalizeSuiAddress(chi.toSuiAddress());
  const A = normalizeSuiAddress(ava.toSuiAddress());
  const B = normalizeSuiAddress(bao.toSuiAddress());
  let potId = "";

  await test.step("a fresh (test) pot: three joins, two pulls", async () => {
    await timed("setup", async () => {
      const stamp = new Date().toISOString().slice(5, 16).replace("T", " ");
      const created = await post<{ potId: string; digest: string }>("/api/pots", {
        creator: A,
        name: `Agent check ${stamp} (test)`,
        goalUsd: 1,
        deadline: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        quorum: 2,
        windowMinutes: 60,
      });
      potId = created.potId;
      out.pot = potId;
      out.create = created.digest;
      const joins: Record<string, string> = {};
      for (const [kp, name] of [
        [ava, "Ava"],
        [bao, "Bao"],
        [chi, "Chi"],
      ] as const) {
        const j = await post<{ digest: string }>(`/api/pots/${potId}/join`, {
          member: kp.toSuiAddress(),
          name,
          capUsd: 0.4,
        });
        joins[name] = j.digest;
      }
      out.joins = joins;
      const [pot] = await w.db.select().from(pots).where(eq(pots.id, potId));
      const pulled: string[] = [];
      for (const who of [A, B]) {
        const [m] = await w.db
          .select()
          .from(members)
          .where(and(eq(members.potId, potId), eq(members.address, who)));
        if (!pot || !m) throw new Error("pot or member missing");
        const p = await pullMember(
          { db: w.db, chain: w.chain, keeper: w.keeper, memory: w.memory, ours: w.ours },
          pot,
          m,
          { force: true, amount: micro(0.15) },
        );
        expect(p.status).toBe("sent");
        pulled.push(p.digest as string);
      }
      out.pulls = pulled;
    });
  });

  const b = await walletPage(browser, bao, BAO, `/pots/${potId}`);
  await test.step("Bao names the treasurer with a $0.10 cap, from the web", async () => {
    await timed("delegate", async () => {
      await expect(b.getByText("Your agent", { exact: true })).toBeVisible();
      await b.getByLabel("Agent's address").fill(AGENT);
      await b.getByLabel("Approve up to ($)").fill("0.10");
      const d = await signed<{ digest: string; memoryId: string }>(b, () =>
        b.getByRole("button", { name: "Name this agent" }).click(),
      );
      out.delegate = d.digest;
      await expect(b.getByText("named on Sui")).toBeVisible();
      // The treasurer cites what it read, so the mandate's memory must have landed on Walrus.
      let blob: string | null = null;
      for (let i = 0; i < 60 && !blob; i++) {
        const [row] = await w.db
          .select()
          .from(delegates)
          .where(and(eq(delegates.potId, potId), eq(delegates.active, true)));
        if (row?.memoryId) {
          const [m] = await w.db
            .select()
            .from(memories)
            .where(and(eq(memories.id, row.memoryId), isNotNull(memories.blobId)));
          blob = m?.blobId ?? null;
        }
        if (!blob) await new Promise((r) => setTimeout(r, 5_000));
      }
      expect(blob).toBeTruthy();
      out.delegateBlob = blob;
    });
  });

  await test.step("the treasurer approves $0.05 of food for Bao; it executes at quorum", async () => {
    await timed("agentApprove", async () => {
      const p = await post<{ seq: number; digest: string }>(`/api/pots/${potId}/proposals`, {
        kind: "spend",
        proposer: A,
        payee,
        amountUsd: 0.05,
        memo: "food: snacks for the bus",
      });
      out.proposeFood = p.digest;
      const before = await w.chain.usdcAddressBalance(payee);
      const d = treasurer(["review", "--pot", potId, "--member", "Bao", "--seq", String(p.seq)]);
      out.treasurerFood = d;
      expect(d.decision).toBe("approve");
      expect(String(d.result)).toContain("was paid");
      const [cited] = await w.db
        .select()
        .from(memories)
        .where(eq(memories.blobId, String(d.cite)));
      expect(cited?.namespace).toContain(potId);
      out.foodCite = { blob: d.cite, text: cited?.text };
      const [row] = await w.db
        .select()
        .from(proposals)
        .where(and(eq(proposals.potId, potId), eq(proposals.seq, p.seq)));
      expect(row?.executed).toBe(true);
      expect(row?.approvals.at(-1)?.agent).toBe(AGENT);
      out.agentApproveDigest = row?.digest;
      let after = before;
      for (let i = 0; i < 20 && after - before < micro(0.05); i++) {
        await new Promise((r) => setTimeout(r, 3_000));
        after = await w.chain.usdcAddressBalance(payee);
      }
      expect(after - before).toBe(micro(0.05));
    });
  });

  let hotel = -1;
  await test.step("above its cap: the model decides, a forced approval aborts onchain", async () => {
    await timed("overCap", async () => {
      const p = await post<{ seq: number; digest: string }>(`/api/pots/${potId}/proposals`, {
        kind: "spend",
        proposer: A,
        payee,
        amountUsd: 0.2,
        memo: "hotel: deposit for two rooms",
      });
      hotel = p.seq;
      out.proposeHotel = p.digest;
      const d = treasurer(["review", "--pot", potId, "--member", "Bao", "--seq", String(p.seq)]);
      out.treasurerHotel = d;
      const forced = treasurer([
        "approve",
        "--pot",
        potId,
        "--member",
        "Bao",
        "--seq",
        String(p.seq),
        "--reason",
        "testing that the chain refuses an approval above the $0.10 cap",
        "--record-refusal",
      ]);
      out.forcedOverCap = forced;
      expect(String(forced.result)).toContain("EOverDelegateCap");
      const digest = recorded(forced.result);
      expect(digest).toBeTruthy();
      await failedOnchain(digest as string, "EOverDelegateCap");
      out.overCapDigest = digest;
    });
  });

  await test.step("Bao sees 'needs you' and approves the hotel himself", async () => {
    await timed("memberApprove", async () => {
      await b.reload();
      await expect(b.getByText("needs you", { exact: true })).toBeVisible();
      const paid = await signed(b, () =>
        b.getByRole("button", { name: "Approve and pay" }).click(),
      );
      out.baoApprovesHotel = paid.digest;
      const [row] = await w.db
        .select()
        .from(proposals)
        .where(and(eq(proposals.potId, potId), eq(proposals.seq, hotel)));
      expect(row?.executed).toBe(true);
    });
  });

  await test.step("screenshots: the pot with its agent, desktop and phone, light and dark", async () => {
    mkdirSync(shots, { recursive: true });
    for (const scheme of ["light", "dark"] as const) {
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 2600 },
        colorScheme: scheme,
      });
      const page = await ctx.newPage();
      await installTestWallet(page, bao, BAO, w.client);
      await page.goto(`/pots/${potId}`);
      await connect(page, BAO);
      await expect(page.getByText("Your agent", { exact: true })).toBeVisible();
      await expect(page.getByText("Bao's agent").first()).toBeVisible();
      await page.screenshot({ path: `${shots}/pot-agent-1280-${scheme}.png` });
      await page.setViewportSize({ width: 375, height: 3600 });
      await page.reload();
      await expect(page.getByText("Your agent", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        375,
      );
      await page.screenshot({ path: `${shots}/pot-agent-375-${scheme}.png` });
      await ctx.close();
    }
  });

  await test.step("Bao revokes the agent; its next approval aborts onchain", async () => {
    await timed("revoke", async () => {
      await b.reload();
      await b.getByRole("button", { name: "Revoke agent…" }).click();
      const r = await signed(b, () =>
        b.getByRole("button", { name: "Revoke agent", exact: true }).click(),
      );
      out.revoke = r.digest;
      const p = await post<{ seq: number; digest: string }>(`/api/pots/${potId}/proposals`, {
        kind: "spend",
        proposer: A,
        payee,
        amountUsd: 0.03,
        memo: "food: water",
      });
      out.proposeWater = p.digest;
      const forced = treasurer([
        "approve",
        "--pot",
        potId,
        "--member",
        "Bao",
        "--seq",
        String(p.seq),
        "--reason",
        "testing that a revoked agent can't approve",
        "--record-refusal",
      ]);
      out.forcedAfterRevoke = forced;
      expect(String(forced.result)).toContain("ENotDelegate");
      const digest = recorded(forced.result);
      expect(digest).toBeTruthy();
      await failedOnchain(digest as string, "ENotDelegate");
      out.afterRevokeDigest = digest;
    });
  });

  await test.step("what Kitty remembered", async () => {
    const rows = await w.db
      .select()
      .from(memories)
      .where(eq(memories.namespace, `kitty:pot:${potId}:norms`));
    out.normsMemories = rows.map((r) => ({
      text: r.text.slice(0, 140),
      blob: r.blobId,
      status: r.status,
    }));
    expect(rows.some((r) => r.text.startsWith("AGENT_APPROVED"))).toBe(true);
    expect(rows.some((r) => r.text.startsWith("AGENT_REFUSED"))).toBe(true);
  });
});

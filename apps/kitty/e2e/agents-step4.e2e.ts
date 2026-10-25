/**
 * U12 exit, step 4 re-run (KT4, ADR-0067), on testnet: the $0.20 step with the agent's own model making
 * the approval. Bao asks the treasurer himself (`review --ask`). The model decides, and the chain refuses
 * anything above the cap. On the U12 exit pot:
 * 1. The keeper pulls $0.10 from Ava and from Bao, so the pot can pay a $0.20 hotel.
 * 2. Bao names the treasurer again with a $0.10 cap, from the web (an injected test wallet).
 * 3. Ava proposes $0.20 "hotel: second night". Bao asks the treasurer to approve it. If the model
 *    approves, the approval is sent anyway, and the chain refuses it (EOverDelegateCap), with a digest.
 * 4. The pot page shows the refused attempt and "needs you" (screenshots), and Bao approves in the web.
 * 5. Bao revokes the treasurer again, so the pot ends as before.
 * The record goes to test-results/kitty-u12-step4-rerun.json; screenshots to test-results/u12/.
 * `STEP4_RESUME_SEQ=<n>` resumes after step 3 (from the saved first part), re-running only what's left.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const POT = "0x85a83ed3c0939614dea0352100851144f7d208131a4eb4d6649f6373e2a71967";
const ASK = "Bao: please approve the hotel's second night";
const env = readEnv();
const w = wire(env, () => {});
const [ava, bao, chi] = (env.KITTY_MEMBER_KEYS ?? "")
  .split(",")
  .filter(Boolean)
  .map((k) => keypairFrom(k, "KITTY_MEMBER_KEYS")) as [Keypair, Keypair, Keypair];
const agentKey = process.env.KITTY_AGENT_KEY;
const AGENT = agentKey
  ? normalizeSuiAddress(keypairFrom(agentKey, "KITTY_AGENT_KEY").toSuiAddress())
  : "";
const API = "http://localhost:8821";
const app = resolve(import.meta.dirname, "..");
const results = resolve(app, "test-results");
const shots = resolve(results, "u12");
const BAO = "Kitty test wallet (Bao)";
const resume = process.env.STEP4_RESUME_SEQ ? Number(process.env.STEP4_RESUME_SEQ) : null;
const part1 = resolve(results, "kitty-u12-step4-rerun.part1.json");
const out: Record<string, unknown> =
  resume !== null && existsSync(part1)
    ? { ...JSON.parse(readFileSync(part1, "utf8")), resumedAt: new Date().toISOString() }
    : { startedAt: new Date().toISOString(), pot: POT, ask: ASK };
const timings: Record<string, number> = (out.timings as Record<string, number>) ?? {};

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

/** Connects at desktop width (on a phone the wallet button sits in the sidebar's sheet), then resizes. */
async function walletPage(browser: Browser, path: string, width = 1280, scheme?: "light" | "dark") {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 2600 },
    ...(scheme ? { colorScheme: scheme } : {}),
  });
  const page = await ctx.newPage();
  await installTestWallet(page, bao, BAO, w.client);
  await page.goto(path);
  await connect(page, BAO);
  if (width !== 1280) {
    await page.setViewportSize({ width, height: 3600 });
    await page.reload();
  }
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

/** The pot page at 1280 and 375, light and dark; nothing wider than the phone. */
async function screenshots(browser: Browser, label: string, expectText: string) {
  mkdirSync(shots, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    for (const width of [1280, 375]) {
      const page = await walletPage(browser, `/pots/${POT}`, width, scheme);
      await expect(page.getByText(expectText, { exact: true }).first()).toBeVisible();
      if (width === 375) {
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          375,
        );
        const wide = await page.evaluate(
          () =>
            Array.from(document.querySelectorAll("main *")).filter(
              (e) => e.getBoundingClientRect().right > 376,
            ).length,
        );
        expect(wide).toBe(0);
      }
      await page.screenshot({ path: `${shots}/step4-${label}-${width}-${scheme}.png` });
      await page.context().close();
    }
  }
}

test.afterAll(() => {
  out.timings = timings;
  out.finishedAt = new Date().toISOString();
  mkdirSync(results, { recursive: true });
  writeFileSync(`${results}/kitty-u12-step4-rerun.json`, JSON.stringify(out, null, 2));
});

test("step 4 again: Bao asks his agent to approve $0.20; the chain refuses; Bao decides", async ({
  browser,
}) => {
  test.skip(!ava || !bao || !chi || !AGENT, "needs KITTY_MEMBER_KEYS and KITTY_AGENT_KEY");
  test.setTimeout(30 * 60_000);
  const payee = normalizeSuiAddress(chi.toSuiAddress());

  let seq = resume ?? -1;
  if (resume === null) {
    await test.step("the keeper pulls $0.10 from Ava and from Bao", async () => {
      await timed("pulls", async () => {
        const [pot] = await w.db.select().from(pots).where(eq(pots.id, POT));
        const pulled: string[] = [];
        for (const who of [ava, bao]) {
          const [m] = await w.db
            .select()
            .from(members)
            .where(
              and(
                eq(members.potId, POT),
                eq(members.address, normalizeSuiAddress(who.toSuiAddress())),
              ),
            );
          if (!pot || !m) throw new Error("pot or member missing");
          const p = await pullMember(
            { db: w.db, chain: w.chain, keeper: w.keeper, memory: w.memory, ours: w.ours },
            pot,
            m,
            { force: true, amount: micro(0.1) },
          );
          expect(p.status).toBe("sent");
          pulled.push(p.digest as string);
        }
        out.pulls = pulled;
      });
    });

    const first = await walletPage(browser, `/pots/${POT}`);
    await test.step("Bao names the treasurer again with a $0.10 cap, from the web", async () => {
      await timed("delegate", async () => {
        await first.getByLabel("Agent's address").fill(AGENT);
        await first.getByLabel("Approve up to ($)").fill("0.10");
        const d = await signed(first, () =>
          first.getByRole("button", { name: "Name this agent" }).click(),
        );
        out.delegate = d.digest;
        let blob: string | null = null;
        for (let i = 0; i < 60 && !blob; i++) {
          const [row] = await w.db
            .select()
            .from(delegates)
            .where(and(eq(delegates.potId, POT), eq(delegates.active, true)));
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

    await first.context().close();
    await test.step("Ava proposes $0.20; Bao asks his agent; the model decides", async () => {
      await timed("agent", async () => {
        const p = await post<{ seq: number; digest: string }>(`/api/pots/${POT}/proposals`, {
          kind: "spend",
          proposer: normalizeSuiAddress(ava.toSuiAddress()),
          payee,
          amountUsd: 0.2,
          memo: "hotel: second night",
        });
        seq = p.seq;
        out.propose = { seq, digest: p.digest };
        const d = treasurer([
          "review",
          "--pot",
          POT,
          "--member",
          "Bao",
          "--seq",
          String(seq),
          "--ask",
          ASK,
        ]);
        out.treasurer = d;
        if (d.decision === "approve") {
          expect(String(d.result)).toContain("EOverDelegateCap");
          const digest = /Recorded onchain: (\w{40,50})/.exec(String(d.result))?.[1];
          expect(digest).toBeTruthy();
          const res = await w.client.core.getTransaction({
            digest: digest as string,
            include: { effects: true },
          });
          const t = res.Transaction ?? res.FailedTransaction;
          expect(t?.effects?.status.success).toBe(false);
          expect(JSON.stringify(t?.effects?.status.error)).toContain("EOverDelegateCap");
          out.refusedDigest = digest;
          const [cited] = await w.db
            .select()
            .from(memories)
            .where(eq(memories.blobId, String(d.cite)));
          out.cite = { blob: d.cite, text: cited?.text };
        } else {
          out.note = "The model declined; nothing was forced.";
        }
      });
    });
  }
  if (seq < 0) throw new Error("no proposal");
  mkdirSync(results, { recursive: true });
  writeFileSync(part1, JSON.stringify({ ...out, timings }, null, 2));

  await test.step("screenshots before Bao decides: the refused attempt and 'needs you'", async () => {
    await screenshots(browser, "before", "needs you");
  });

  const b = await walletPage(browser, `/pots/${POT}`);
  await test.step("Bao approves the hotel's second night in the web; it's paid", async () => {
    await timed("memberApprove", async () => {
      const card = b.locator('[data-slot="card"]').filter({ hasText: "hotel: second night" });
      await expect(card.getByText("needs you", { exact: true })).toBeVisible();
      const paid = await signed(b, () =>
        card.getByRole("button", { name: "Approve and pay" }).click(),
      );
      out.baoApproves = paid.digest;
      const [row] = await w.db
        .select()
        .from(proposals)
        .where(and(eq(proposals.potId, POT), eq(proposals.seq, seq)));
      expect(row?.executed).toBe(true);
    });
  });

  await test.step("screenshots after: paid, the agent's refused attempt kept", async () => {
    await screenshots(browser, "after", "Your agent");
  });

  await test.step("Bao revokes the treasurer again", async () => {
    await timed("revoke", async () => {
      await b.reload();
      await b.getByRole("button", { name: "Revoke agent…" }).click();
      const r = await signed(b, () =>
        b.getByRole("button", { name: "Revoke agent", exact: true }).click(),
      );
      out.revoke = r.digest;
      const active = await w.db
        .select()
        .from(delegates)
        .where(and(eq(delegates.potId, POT), eq(delegates.active, true)));
      expect(active).toHaveLength(0);
    });
  });
});

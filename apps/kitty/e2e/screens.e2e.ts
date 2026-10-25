/**
 * Screenshots of the web in Remora's design (ADR-0066): Home and a pot page, desktop and phone, light
 * and dark, into test-results/screens/. It spends nothing: Bao's test wallet connects but signs no
 * transaction.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { wire } from "../src/deps.ts";
import { readEnv } from "../src/env.ts";
import { keypairFrom } from "../src/keys.ts";
import { connect, installTestWallet } from "./test-wallet.ts";

const env = readEnv();
const w = wire(env, () => {});
const bao = (env.KITTY_MEMBER_KEYS ?? "").split(",").filter(Boolean)[1];
const out = resolve(import.meta.dirname, "../test-results/screens");
const NAME = "Kitty test wallet (Bao)";

test("screenshots: Home and a pot, desktop and phone, light and dark", async ({ browser }) => {
  test.skip(!bao, "needs KITTY_MEMBER_KEYS");
  mkdirSync(out, { recursive: true });
  const pots = (await (await fetch("http://localhost:8821/api/pots")).json()) as {
    id: string;
    closed: boolean;
  }[];
  const pot = pots.find((p) => !p.closed) ?? pots[0];
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
      colorScheme: scheme,
    });
    const page = await ctx.newPage();
    await installTestWallet(page, keypairFrom(bao, "KITTY_MEMBER_KEYS"), NAME, w.client);
    await page.goto("/");
    await connect(page, NAME);
    await expect(
      page.getByRole("heading", { name: "The group pot that saves itself" }),
    ).toBeVisible();
    await page.screenshot({ path: `${out}/home-desktop-${scheme}.png` });
    if (pot) {
      await page.goto(`/pots/${pot.id}`);
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
      await page.screenshot({ path: `${out}/pot-desktop-${scheme}.png` });
    }
    await page.setViewportSize({ width: 375, height: 1400 });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "The group pot that saves itself" }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );
    await page.screenshot({ path: `${out}/home-375-${scheme}.png` });
    if (pot) {
      await page.goto(`/pots/${pot.id}`);
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        375,
      );
      await page.screenshot({ path: `${out}/pot-375-${scheme}.png` });
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      // The sheet slides in over 500 ms.
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${out}/sidebar-375-${scheme}.png` });
    }
    await ctx.close();
  }
});

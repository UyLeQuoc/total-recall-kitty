/**
 * Kitty's process (ADR-0062, ADR-0064): the API, and the built web when `web/dist` exists, always; the
 * keeper and the payday stream with `KITTY_WORKER=on`; the bot with `KITTY_BOT=on` (one poller per
 * token, ADR-0060).
 */
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { tatumUsage } from "@total-recall/chain";
import { eq } from "drizzle-orm";
import { createApp } from "./app.ts";
import { createBot } from "./bot.ts";
import { members, pots } from "./db/index.ts";
import { wire } from "./deps.ts";
import { readEnv } from "./env.ts";
import { keeperPass, onInflow } from "./keeper.ts";
import { startWatcher } from "./watcher.ts";

const env = readEnv();
const log = (msg: string, data: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({ t: new Date().toISOString(), msg, ...data }, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  );
const w = wire(env, log);
const app = createApp({
  ...w,
  keeper: w.keeper.toSuiAddress(),
  webDist: fileURLToPath(new URL("../web/dist", import.meta.url)),
});
const server = serve({ fetch: app.fetch, port: env.KITTY_PORT });
log("kitty.listening", { port: env.KITTY_PORT, memory: !!w.memory, members: w.keys.size });

const stops: (() => void)[] = [];
if (env.KITTY_WORKER === "on") {
  const keeperDeps = {
    db: w.db,
    chain: w.chain,
    keeper: w.keeper,
    memory: w.memory,
    log,
    ours: w.ours,
  };
  let busy = false;
  const pass = async () => {
    if (busy) return;
    busy = true;
    try {
      await keeperPass(keeperDeps);
    } catch (err) {
      log("keeper.failed", { error: String(err) });
    } finally {
      busy = false;
    }
  };
  const t = setInterval(pass, env.KITTY_KEEPER_SECONDS * 1000);
  stops.push(() => clearInterval(t));
  stops.push(
    startWatcher({
      client: w.client,
      coinType: w.chain.coinType,
      log,
      addresses: async () => {
        const open = await w.db.select({ id: pots.id }).from(pots).where(eq(pots.closed, false));
        const ids = new Set(open.map((p) => p.id));
        return (await w.db.select().from(members).where(eq(members.active, true)))
          .filter((m) => ids.has(m.potId))
          .map((m) => m.address);
      },
      onInflow: (i, checkpoint) => onInflow(keeperDeps, i.address, i.amount, i.digest, checkpoint),
    }),
  );
  log("kitty.worker", { keeperSeconds: env.KITTY_KEEPER_SECONDS });
}
if (env.KITTY_BOT === "on" && env.TELEGRAM_BOT_TOKEN) {
  const bot = createBot(env.TELEGRAM_BOT_TOKEN, { ...w, baseUrl: env.KITTY_BASE_URL });
  void bot.start({
    drop_pending_updates: true,
    onStart: (me) => log("kitty.bot", { username: me.username }),
  });
  stops.push(() => void bot.stop());
}

const stop = async () => {
  for (const s of stops) s();
  await w.memory?.flush();
  log("tatum.usage", tatumUsage());
  server.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

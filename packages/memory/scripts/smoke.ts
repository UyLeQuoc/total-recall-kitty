/**
 * Smoke test against the configured relayer.
 *   bun run smoke           → health, identity, stats, agents (read only)
 *   bun run smoke --write   → also writes one memory to hippo-guest:smoke and recalls it
 */
import {
  buildMemoryText,
  createClient,
  guestScope,
  NAMESPACE,
  RelayerExtras,
  readOperatorEnv,
  recallRelevant,
  rememberWithDedupe,
} from "../src/index.ts";

const write = process.argv.includes("--write");
const env = readOperatorEnv();
const operator = {
  key: env.MEMWAL_PRIVATE_KEY,
  accountId: env.MEMWAL_ACCOUNT_ID,
  serverUrl: env.MEMWAL_SERVER_URL,
};
const scope = guestScope(operator, "smoke");
const client = createClient(scope);
const extras = new RelayerExtras(operator);

async function attempt<T>(label: string, fn: () => Promise<T>, tries = 3): Promise<T | null> {
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`${label}: attempt ${i}/${tries} failed — ${msg}`);
      if (i === tries) return null;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  return null;
}

const health = await client.health();
console.log("relayer   :", env.MEMWAL_SERVER_URL, `(${health.status}, ${health.version})`);
console.log("account   :", env.MEMWAL_ACCOUNT_ID);
console.log(
  "agent id  :",
  await client.getPublicKeyHex(),
  "← MEMWAL_AGENT_ID for the submission form",
);

const stats = await attempt("stats", () => extras.stats(scope.namespace));
if (stats) {
  console.log("owner     :", stats.owner);
  console.log(
    `namespace ${scope.namespace}: ${stats.memory_count} memories, ${stats.storage_bytes} bytes`,
  );
  console.log("explorer  :", `https://suiscan.xyz/mainnet/object/${env.MEMWAL_ACCOUNT_ID}`);
}

const agents = await attempt("agents", () => extras.agents());
if (agents) {
  console.log(`agents    : ${agents.agents.length} delegate keys`);
  for (const a of agents.agents) console.log(`  - ${a.label} ${a.sui_address}`);
}

if (!write) {
  console.log(
    `\npass --write to store and recall one memory (namespace ${NAMESPACE.guest("smoke")})`,
  );
} else {
  const line = buildMemoryText({
    type: "profile",
    by: "smoke",
    text: `Smoke test run at ${new Date().toISOString()}. Prefers pnpm and TypeScript strict mode.`,
  });
  console.log("\nwriting:", line);
  const t0 = Date.now();
  const out = await rememberWithDedupe(client, { text: line, namespace: scope.namespace });
  if (out.status === "duplicate") {
    // Every run writes the same fact, so after the first one dedupe finds it.
    // That is the chat path working, not a write that failed.
    console.log(
      `→ nothing written: an earlier run already stored this fact as ${out.blobId} (distance ${out.distance.toFixed(3)}), found in ${Date.now() - t0} ms`,
    );
  } else {
    console.log(`→ accepted job ${out.jobId} in ${Date.now() - t0} ms (reply would return here)`);
    const settled = await out.settled;
    console.log(
      `→ settled ${settled.status} blob=${settled.blobId} after ${Date.now() - t0} ms total`,
    );
  }
  const hits = await recallRelevant(client, {
    query: "which package manager does the user prefer?",
    namespace: scope.namespace,
    limit: 3,
    maxDistance: 0.8,
  });
  console.log(`recall returned ${hits.length} (distance, lower is closer):`);
  for (const h of hits) console.log(`  ${h.distance.toFixed(3)}  ${h.text}`);
}

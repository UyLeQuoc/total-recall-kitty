/**
 * Can a single recall find a person's corrections, and nothing else?
 *
 * A correction only helps if the model sees it next to the fact it corrects.
 * Measured on 2026-09-24, it often does not: asked "what do you know about
 * me?", the session-start profile pull returned the stale fact and never the
 * correction, so the model stated the stale fact as current. Ordering and the
 * conflict rule cannot fix a memory that was never recalled.
 *
 * Every correction's stored text begins with the literal tag `[correction]`,
 * so the tag itself is a query. This measures whether it separates corrections
 * from everything else, including distractors that talk about correcting or
 * changing things without being corrections, and a correction long enough that
 * the tag is a small share of its text.
 *
 * Usage: tsx scripts/spike-corrections.ts            write, wait, measure
 *        SPIKE_ID=<id> tsx scripts/spike-corrections.ts   measure an earlier run
 */
import type { MemoryType } from "../src/format.ts";
import { createMemoryPort, readOperatorEnv } from "../src/index.ts";

const env = readOperatorEnv();
const reuse = process.env.SPIKE_ID;
const personId = `spike-corrections-${reuse ?? Date.now().toString(36)}`;
const port = createMemoryPort({
  scope: {
    mode: "guest",
    key: env.MEMWAL_PRIVATE_KEY,
    accountId: env.MEMWAL_ACCOUNT_ID,
    serverUrl: env.MEMWAL_SERVER_URL,
    namespace: `hippo-guest:${personId}`,
  },
  by: "spike",
  channel: "spike",
});

const MEMORIES: Array<[MemoryType, string]> = [
  ["profile", "I work in Go and Rust at a fintech in Hanoi."],
  ["profile", "I use VS Code with vim bindings."],
  [
    "decision",
    "We chose Postgres over MongoDB for the ledger service because we need transactions.",
  ],
  ["gotcha", "Staging deploys fail while the migration lock is held; run unlock-migrations first."],
  ["commitment", "I promised to ship the billing export by October 3."],
  ["style", "Answer in English, short, with code first."],
  // Distractors: the words, not the type.
  ["profile", "My team corrected the API naming last sprint to use kebab-case routes."],
  ["decision", "We changed the logging library from winston to pino for speed."],
  // The corrections, short to long.
  ["correction", "I moved to Neovim; I no longer use VS Code."],
  ["correction", "The billing export deadline moved to October 10, not October 3."],
  [
    "correction",
    "The ledger service is in Rust now. The Go version was retired in August, after a migration that took most of the summer, three people, and a rewrite of the reconciliation job that nobody wants to repeat.",
  ],
];

if (!reuse) {
  console.log(`writing ${MEMORIES.length} memories to ${port.scope.namespace}`);
  for (const [type, text] of MEMORIES) await port.remember({ type, text });
  await port.flush();
  console.log("written; waiting 60s for indexing");
  await new Promise((r) => setTimeout(r, 60_000));
}

const results = await port.recall({ query: "[correction]", limit: 11, maxDistance: 1 });
console.log(`\nquery "[correction]" in ${port.scope.namespace}: ${results.length} returned`);
for (const m of results) {
  const mark = m.parsed?.type === "correction" ? "CORRECTION" : "          ";
  console.log(`  d=${m.distance.toFixed(3)}  ${mark}  ${(m.parsed?.text ?? m.text).slice(0, 70)}`);
}
const corr = results.filter((m) => m.parsed?.type === "correction").map((m) => m.distance);
const other = results.filter((m) => m.parsed?.type !== "correction").map((m) => m.distance);
console.log(
  `\nfarthest correction ${Math.max(...corr).toFixed(3)}, nearest non-correction ${Math.min(...other).toFixed(3)}, corrections found ${corr.length}/3`,
);

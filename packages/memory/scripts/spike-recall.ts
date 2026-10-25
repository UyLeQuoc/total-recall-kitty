/**
 * Spike 5 — does the [type] [by:@x] [date] prefix hurt semantic recall?
 * Writes the same facts twice: once prefixed, once bare, into two namespaces,
 * then runs the same queries against both and prints the distance of the
 * expected answer.
 */
import {
  buildMemoryText,
  createClient,
  limiterFor,
  readOperatorEnv,
  runLimited,
} from "../src/index.ts";

const env = readOperatorEnv();
const stamp = process.env.SPIKE_ID ?? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const NS_TAGGED = `spike-recall-tagged:${stamp}`;
const NS_BARE = `spike-recall-bare:${stamp}`;
const base = {
  key: env.MEMWAL_PRIVATE_KEY,
  accountId: env.MEMWAL_ACCOUNT_ID,
  serverUrl: env.MEMWAL_SERVER_URL,
};
const client = createClient({ mode: "guest", ...base, namespace: NS_TAGGED });

const FACTS: Array<{
  type: "profile" | "decision" | "gotcha" | "style" | "commitment";
  text: string;
}> = [
  { type: "profile", text: "Uy prefers pnpm over npm and yarn for every project." },
  { type: "profile", text: "Uy works mainly on Sui and Next.js, in TypeScript strict mode." },
  { type: "profile", text: "Uy lives in Ho Chi Minh City and works in the UTC+7 timezone." },
  {
    type: "decision",
    text: "The team decided on 25 September 2026 to use Drizzle instead of Prisma for the ORM.",
  },
  {
    type: "decision",
    text: "We chose Gemini 2.5 Flash through OpenRouter as the primary model, not GPT or Claude.",
  },
  {
    type: "gotcha",
    text: "The Vercel AI SDK middleware needs specificationVersion v3 or wrapLanguageModel throws.",
  },
  {
    type: "gotcha",
    text: "Walrus Memory recall has no default relevance threshold, so small namespaces return filler.",
  },
  {
    type: "gotcha",
    text: "Postgres on port 5432 clashes with another project, so this repo uses 5433.",
  },
  { type: "style", text: "Uy wants short replies in Vietnamese with no emoji." },
  { type: "commitment", text: "Minh will ship the wallet connect page by 26 September 2026." },
];

const QUERIES: Array<{ q: string; expect: string }> = [
  { q: "which package manager should I use?", expect: "pnpm" },
  { q: "what language and framework does the user work in?", expect: "Sui and Next.js" },
  { q: "where does the user live?", expect: "Ho Chi Minh" },
  { q: "which ORM did we pick?", expect: "Drizzle" },
  { q: "what model are we building with?", expect: "Gemini" },
  { q: "why does wrapLanguageModel throw?", expect: "specificationVersion" },
  { q: "recall returns irrelevant results, why?", expect: "relevance threshold" },
  { q: "what port is the database on?", expect: "5433" },
  { q: "how should I reply to this user?", expect: "Vietnamese" },
  { q: "what is pending and who owns it?", expect: "Minh" },
];

async function seed() {
  console.log(`seeding ${FACTS.length} facts × 2 namespaces…`);
  const limiter = limiterFor(env.MEMWAL_PRIVATE_KEY, { capacity: 12, concurrency: 2 });
  const jobs: Promise<unknown>[] = [];
  for (const f of FACTS) {
    const tagged = buildMemoryText({
      type: f.type,
      by: "uy",
      date: new Date("2026-09-21"),
      text: f.text,
    });
    jobs.push(runLimited(limiter, () => client.remember(tagged, NS_TAGGED)));
    jobs.push(runLimited(limiter, () => client.remember(f.text, NS_BARE)));
  }
  await Promise.all(jobs);
  console.log("accepted; waiting 45s for indexing…");
  await new Promise((r) => setTimeout(r, 45_000));
}

async function measure(namespace: string, label: string) {
  let found = 0;
  let sum = 0;
  const rows: string[] = [];
  for (const { q, expect } of QUERIES) {
    const res = await runLimited(limiterFor(env.MEMWAL_PRIVATE_KEY), () =>
      client.recall({ query: q, namespace, limit: 5 }),
    );
    const meta = res as unknown as { total?: number; dropped_count?: number };
    if (!res.results.length) {
      rows.push(`  EMPTY ${q}  (total ${meta.total ?? "?"}, dropped ${meta.dropped_count ?? "?"})`);
      continue;
    }
    const idx = res.results.findIndex((m) => m.text.toLowerCase().includes(expect.toLowerCase()));
    const top = res.results[0];
    if (idx === -1) {
      rows.push(`  MISS  ${q}  (top ${top ? top.distance.toFixed(3) : "n/a"})`);
    } else {
      const hit = res.results[idx];
      if (!hit) continue;
      found++;
      sum += hit.distance;
      rows.push(`  rank ${idx + 1} dist ${hit.distance.toFixed(3)}  ${q}`);
    }
  }
  console.log(`\n${label} (${namespace})`);
  for (const r of rows) console.log(r);
  console.log(
    `  → found ${found}/${QUERIES.length}, mean distance of hits ${found ? (sum / found).toFixed(3) : "n/a"}`,
  );
  return { found, mean: found ? sum / found : Number.NaN };
}

if (!process.argv.includes("--measure-only")) {
  console.log("waiting 65s for the rate-limit window to clear…");
  await new Promise((r) => setTimeout(r, 65_000));
  await seed();
}
const tagged = await measure(NS_TAGGED, "WITH [type][by][date] prefix");
const bare = await measure(NS_BARE, "BARE text");
console.log("\nverdict:");
console.log(
  `  recall@5   tagged ${tagged.found}/${QUERIES.length} vs bare ${bare.found}/${QUERIES.length}`,
);
console.log(
  `  mean dist  tagged ${tagged.mean.toFixed(3)} vs bare ${bare.mean.toFixed(3)}  (delta ${(tagged.mean - bare.mean).toFixed(3)})`,
);
console.log(`  namespaces: ${NS_TAGGED} / ${NS_BARE}`);

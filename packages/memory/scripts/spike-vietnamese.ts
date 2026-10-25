/**
 * Does recall work in Vietnamese, and do diacritics survive the round trip?
 *
 * hippo's first real users are Vietnamese and it already answers in Vietnamese
 * when a `style` memory says so, so this is not a curiosity: if embeddings or
 * storage mangle the language, the whole real-use week is built on sand.
 *
 * Checks three things:
 *   1. the text comes back byte-identical, diacritics intact
 *   2. a Vietnamese question finds a Vietnamese fact
 *   3. a Vietnamese question finds an equivalent English fact, and vice versa
 */
import {
  buildMemoryText,
  createClient,
  limiterFor,
  readOperatorEnv,
  runLimited,
} from "../src/index.ts";

const env = readOperatorEnv();
const stamp = process.env.SPIKE_ID ?? Date.now().toString(36);
const NS = `spike-vi:${stamp}`;
const base = {
  key: env.MEMWAL_PRIVATE_KEY,
  accountId: env.MEMWAL_ACCOUNT_ID,
  serverUrl: env.MEMWAL_SERVER_URL,
};
const client = createClient({ mode: "guest", ...base, namespace: NS });
const limiter = limiterFor(env.MEMWAL_PRIVATE_KEY, { capacity: 20, concurrency: 1 });

const FACTS = [
  { type: "profile" as const, text: "Uy thích dùng pnpm, không bao giờ dùng npm hay yarn." },
  { type: "profile" as const, text: "Uy sống ở Thành phố Hồ Chí Minh và làm việc múi giờ UTC+7." },
  {
    type: "gotcha" as const,
    text: "Cổng 5432 đã bị chiếm nên dự án này chạy Postgres ở cổng 5433.",
  },
  { type: "decision" as const, text: "Nhóm quyết định dùng Drizzle thay cho Prisma làm ORM." },
  { type: "style" as const, text: "Trả lời ngắn gọn bằng tiếng Việt, không dùng emoji." },
  // One English fact, to test cross-language recall in both directions.
  { type: "profile" as const, text: "Uy's favourite editor is Neovim, configured in Lua." },
];

const QUERIES: Array<{ q: string; expect: string; kind: string }> = [
  { q: "tôi dùng trình quản lý gói nào?", expect: "pnpm", kind: "vi → vi" },
  { q: "tôi sống ở đâu?", expect: "Hồ Chí Minh", kind: "vi → vi" },
  { q: "cơ sở dữ liệu chạy ở cổng nào?", expect: "5433", kind: "vi → vi" },
  { q: "nhóm chọn ORM nào?", expect: "Drizzle", kind: "vi → vi" },
  { q: "tôi muốn được trả lời như thế nào?", expect: "tiếng Việt", kind: "vi → vi" },
  { q: "tôi dùng editor gì?", expect: "Neovim", kind: "vi → en" },
  { q: "which package manager do I use?", expect: "pnpm", kind: "en → vi" },
  { q: "where does the user live?", expect: "Hồ Chí Minh", kind: "en → vi" },
];

if (!process.argv.includes("--measure-only")) {
  console.log(`seeding ${FACTS.length} facts into ${NS}…`);
  for (const f of FACTS) {
    const line = buildMemoryText({
      type: f.type,
      by: "uy",
      date: new Date("2026-09-22"),
      text: f.text,
    });
    await runLimited(limiter, () => client.remember(line, NS));
  }
  console.log("accepted; waiting 100s for indexing…");
  await new Promise((r) => setTimeout(r, 100_000));
}

console.log("\n1. Byte fidelity — is the text returned exactly as written?");
const all = await runLimited(limiter, () =>
  client.recall({ query: "Uy", namespace: NS, limit: 20 }),
);
let intact = 0;
for (const f of FACTS) {
  const hit = all.results.find((m) => m.text.includes(f.text));
  if (hit) {
    intact++;
  } else {
    const near = all.results.find((m) => m.text.includes(f.text.slice(0, 12)));
    console.log(`  MANGLED or missing: ${f.text.slice(0, 50)}`);
    if (near) console.log(`    came back as:     ${near.text}`);
  }
}
console.log(`  ${intact}/${FACTS.length} returned byte-identical`);

console.log("\n2 & 3. Recall, within and across languages");
let found = 0;
let sum = 0;
for (const { q, expect, kind } of QUERIES) {
  const res = await runLimited(limiter, () => client.recall({ query: q, namespace: NS, limit: 5 }));
  const idx = res.results.findIndex((m) => m.text.includes(expect));
  if (idx === -1) {
    const meta = res as unknown as { dropped_count?: number };
    console.log(
      `  MISS  [${kind}] ${q}  (${res.results.length} results, dropped ${meta.dropped_count ?? 0})`,
    );
    continue;
  }
  const hit = res.results[idx];
  if (!hit) continue;
  found++;
  sum += hit.distance;
  console.log(`  rank ${idx + 1} dist ${hit.distance.toFixed(3)}  [${kind}] ${q}`);
}
console.log(
  `\n${found}/${QUERIES.length} found, mean distance ${found ? (sum / found).toFixed(3) : "n/a"}`,
);
console.log(`namespace: ${NS}`);

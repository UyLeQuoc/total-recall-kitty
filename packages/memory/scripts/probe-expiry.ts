/**
 * How long do our memories actually live?
 *
 * Judging runs to 2026-10-16. If the managed relayer buys few storage epochs,
 * memories written now could expire before anyone looks at them, which would
 * quietly undo the whole submission. `GET /v1/owners/:owner/memories` exposes
 * `end_epoch` and `expires_at`, so this is answerable rather than a worry.
 */
import { RelayerExtras, readOperatorEnv } from "../src/index.ts";

const env = readOperatorEnv();
const extras = new RelayerExtras({
  key: env.MEMWAL_PRIVATE_KEY,
  accountId: env.MEMWAL_ACCOUNT_ID,
  serverUrl: env.MEMWAL_SERVER_URL,
});

const all = await extras.allMemories();
console.log(`${all.length} memories visible on the read API\n`);

const withExpiry = all.filter((m) => m.expires_at);
const withoutExpiry = all.length - withExpiry.length;

if (withoutExpiry) {
  console.log(`${withoutExpiry} have no expires_at yet (the expiry sweep has not resolved them)`);
}

if (withExpiry.length === 0) {
  console.log("Nothing has a resolved expiry, so lifetime cannot be read from here yet.");
  process.exit(0);
}

const now = Date.now();
const days = (iso: string) => (new Date(iso).getTime() - now) / 86_400_000;
const sorted = [...withExpiry].sort(
  (a, b) => new Date(a.expires_at ?? 0).getTime() - new Date(b.expires_at ?? 0).getTime(),
);
const first = sorted[0];
const last = sorted[sorted.length - 1];

console.log(
  "soonest expiry:",
  first?.expires_at,
  `(${days(first?.expires_at ?? "").toFixed(1)} days away, epoch ${first?.end_epoch})`,
);
console.log(
  "latest expiry :",
  last?.expires_at,
  `(${days(last?.expires_at ?? "").toFixed(1)} days away, epoch ${last?.end_epoch})`,
);

const JUDGING = new Date("2026-10-16T00:00:00Z").getTime();
const expiringBeforeJudging = withExpiry.filter(
  (m) => new Date(m.expires_at ?? 0).getTime() < JUDGING,
);
console.log(
  `\nexpiring before judging (2026-10-16): ${expiringBeforeJudging.length} of ${withExpiry.length}`,
);

const statuses = new Map<string, number>();
for (const m of all) statuses.set(m.status, (statuses.get(m.status) ?? 0) + 1);
console.log("status spread:", [...statuses.entries()].map(([k, v]) => `${k} ${v}`).join(", "));

// A newly written memory is the one that matters; the account also holds old ones.
const recent = [...all]
  .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  .slice(0, 5);
console.log("\n5 most recent memories:");
for (const m of recent) {
  const life = m.expires_at ? `${days(m.expires_at).toFixed(1)}d left` : "expiry unresolved";
  console.log(
    `  ${m.created_at.slice(0, 16)}  ns=${m.namespace_id.slice(0, 28).padEnd(28)}  ${life}`,
  );
}

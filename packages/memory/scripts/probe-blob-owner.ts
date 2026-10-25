/** Who owns the Walrus Blob objects behind our memories? */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { readOperatorEnv } from "../src/index.ts";

const env = readOperatorEnv();
const owner = process.argv[2];
if (!owner) throw new Error("usage: tsx scripts/probe-blob-owner.ts <owner-address>");
const client = new SuiGrpcClient({
  network: "mainnet",
  baseUrl: "https://fullnode.mainnet.sui.io:443",
});

console.log("owner:", owner);
let cursor: string | undefined;
const byType = new Map<string, number>();
let pages = 0;
for (;;) {
  const res = await client.core
    .listOwnedObjects({ owner, ...(cursor ? { cursor } : {}) })
    .catch(async (e: unknown) => {
      // Try the other parameter name before giving up; the gRPC field has moved
      // between @mysten/sui majors.
      const alt = await client.core
        .listOwnedObjects({ address: owner, ...(cursor ? { cursor } : {}) } as never)
        .catch(() => null);
      if (alt) return alt;
      throw e;
    });
  for (const o of res.objects ?? []) {
    const t = (o as { type?: string }).type ?? "?";
    const short = t.split("::").slice(-2).join("::");
    byType.set(short, (byType.get(short) ?? 0) + 1);
  }
  pages++;
  cursor = (res as { cursor?: string }).cursor;
  if (!cursor || pages > 10) break;
}
console.log(`objects owned, by type (${pages} page(s)):`);
for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${t}`);
}
const blobs = [...byType.entries()].filter(([t]) => t.toLowerCase().includes("blob"));
console.log(`\nWalrus Blob objects owned by this address: ${blobs.reduce((n, [, c]) => n + c, 0)}`);
console.log(`(relayer: ${env.MEMWAL_SERVER_URL})`);

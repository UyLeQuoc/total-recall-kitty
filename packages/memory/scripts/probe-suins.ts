import { SuiGrpcClient } from "@mysten/sui/grpc";

const client = new SuiGrpcClient({
  network: "mainnet",
  baseUrl: "https://fullnode.mainnet.sui.io:443",
});
const owner = process.argv[2];
if (!owner) throw new Error("usage: tsx scripts/probe-suins.ts <address>");
let cursor: string | undefined;
for (let page = 0; page < 8; page++) {
  const res = await client.core
    .listOwnedObjects({ owner, ...(cursor ? { cursor } : {}) })
    .catch(() => null);
  if (!res) break;
  for (const o of res.objects ?? []) {
    const t = (o as { type?: string }).type ?? "";
    if (!/SuinsRegistration/.test(t)) continue;
    const id = (o as { objectId?: string }).objectId ?? "";
    const full = await client.core
      .getObject({ objectId: id, include: { json: true } })
      .catch(() => null);
    const json = (full?.object as { json?: Record<string, unknown> } | undefined)?.json ?? {};
    console.log(
      `  ${String(json.domain_name ?? json.domain ?? "?")}   expires ${String(json.expiration_timestamp_ms ?? "?")}   ${id}`,
    );
  }
  cursor = (res as { cursor?: string }).cursor;
  if (!cursor) break;
}

import { SuiGrpcClient } from "@mysten/sui/grpc";

const owner = process.argv[2];
if (!owner) throw new Error("usage: tsx scripts/probe-balance.ts <address>");
const client = new SuiGrpcClient({
  network: "mainnet",
  baseUrl: "https://fullnode.mainnet.sui.io:443",
});
const res = await client.core.getBalance({ owner, coinType: "0x2::sui::SUI" }).catch(() => null);
console.log("SUI:", JSON.stringify(res?.balance ?? res ?? "unavailable").slice(0, 200));
const wal = await client.core
  .getBalance({
    owner,
    coinType: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL",
  })
  .catch((e: unknown) => ({ error: String(e).slice(0, 80) }));
console.log("WAL:", JSON.stringify(wal).slice(0, 220));

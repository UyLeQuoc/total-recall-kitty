/**
 * Resolve a MemWalAccount object ID for an owner address via the on-chain
 * AccountRegistry's Table<address, ID>. Ported from
 * memwal/apps/app/src/utils/suiClientCompat.ts, gRPC path only (public
 * fullnodes retired JSON-RPC).
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { fromBase64, fromHex, normalizeSuiAddress, toHex } from "@mysten/sui/utils";

const tableIdCache = new Map<string, string>();

export function createSuiClient(network: "mainnet" | "testnet" = "mainnet"): SuiGrpcClient {
  return new SuiGrpcClient({
    network,
    baseUrl: `https://fullnode.${network}.sui.io:443`,
  });
}

export async function findAccountIdForOwner(
  client: SuiGrpcClient,
  registryId: string,
  ownerAddress: string,
): Promise<string | null> {
  let tableId = tableIdCache.get(registryId);
  if (!tableId) {
    const res = await client.core.getObject({ objectId: registryId, include: { json: true } });
    const json = (res.object as { json?: Record<string, unknown> }).json ?? {};
    const raw = (json.accounts as { id?: string | { id?: string } } | undefined)?.id;
    tableId = typeof raw === "string" ? raw : raw?.id;
    if (!tableId) return null;
    tableIdCache.set(registryId, tableId);
  }

  const field = await client.core
    .getDynamicField({
      parentId: tableId,
      name: { type: "address", bcs: fromHex(normalizeSuiAddress(ownerAddress)) },
    })
    .catch(() => null);
  const bcs = (field as { dynamicField?: { value?: { bcs?: unknown } } } | null)?.dynamicField
    ?.value?.bcs;
  const bytes = typeof bcs === "string" ? fromBase64(bcs) : (bcs as Uint8Array | undefined);
  if (bytes?.length !== 32) return null;
  return `0x${toHex(bytes)}`;
}

export interface RelayerConfig {
  packageId: string;
  network: "mainnet" | "testnet";
  suiRpcUrl: string;
  suiGrpcUrl: string;
  suiTransport: string;
  securityDeleteEnabled?: boolean;
}

let configCache: Promise<RelayerConfig> | null = null;

/**
 * The live deployment parameters. The package is upgradeable, so the package ID
 * in the docs goes stale: on 2026-09-21 the mainnet relayer reported
 * 0xe7c16fbe… while docs/contract/overview.md still said 0xcee7a6fd… (the
 * original package, which objects still carry in their type). Move calls must
 * target what this returns, never a hardcoded value.
 */
export function fetchRelayerConfig(serverUrl: string): Promise<RelayerConfig> {
  configCache ??= fetch(`${serverUrl.replace(/\/+$/, "")}/config`, {
    signal: AbortSignal.timeout(15_000),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`GET /config → ${res.status}`);
    return (await res.json()) as RelayerConfig;
  });
  return configCache;
}

export interface OnChainDelegate {
  publicKeyHex: string;
  suiAddress: string;
  label: string;
}

export interface OnChainAccount {
  accountId: string;
  owner: string;
  active: boolean;
  delegates: OnChainDelegate[];
}

function normaliseKey(value: unknown): string {
  if (typeof value === "string") {
    // gRPC JSON encodes vector<u8> as base64; a hex string passes through.
    if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
    return toHex(fromBase64(value));
  }
  if (Array.isArray(value)) return toHex(Uint8Array.from(value as number[]));
  return "";
}

/** Objects keep their original package in their type after a Move upgrade. */
const ACCOUNT_TYPE_SUFFIX = "::account::MemWalAccount";

/**
 * Read a MemWalAccount straight from chain. The relayer is not the authority here.
 *
 * The object's type is checked, not just its shape. The connect callback takes
 * the user's wallet from this object's `owner`, and plenty of unrelated Sui
 * objects have an `owner` field; without the type check a caller could name one
 * of those and have its owner treated as their wallet. Returns null for
 * anything that is not a MemWalAccount.
 */
export async function readAccount(
  client: SuiGrpcClient,
  accountId: string,
): Promise<OnChainAccount | null> {
  const res = await client.core
    .getObject({ objectId: accountId, include: { json: true } })
    .catch(() => null);
  const object = res?.object as { json?: Record<string, unknown>; type?: string } | undefined;
  if (!object?.type?.endsWith(ACCOUNT_TYPE_SUFFIX)) return null;
  const json = object.json;
  if (!json) return null;
  const rawDelegates = Array.isArray(json.delegate_keys) ? json.delegate_keys : [];
  return {
    accountId,
    owner: String(json.owner ?? ""),
    active: json.active !== false,
    delegates: rawDelegates.map((d) => {
      const f =
        (d as { fields?: Record<string, unknown> }).fields ?? (d as Record<string, unknown>);
      return {
        publicKeyHex: normaliseKey(f.public_key),
        suiAddress: String(f.sui_address ?? ""),
        label: String(f.label ?? ""),
      };
    }),
  };
}

/**
 * The only trustworthy answer to "did the user really grant us access?".
 * The browser's success callback is a claim; this is the proof.
 */
export async function isDelegateRegistered(
  client: SuiGrpcClient,
  accountId: string,
  publicKeyHex: string,
): Promise<boolean> {
  const account = await readAccount(client, accountId);
  if (!account?.active) return false;
  const wanted = publicKeyHex.toLowerCase().replace(/^0x/, "");
  return account.delegates.some((d) => d.publicKeyHex === wanted);
}

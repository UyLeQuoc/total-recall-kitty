import { ChannelCredentials } from "@grpc/grpc-js";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { PacedTransport } from "./paced.ts";

export type SuiNetwork = "mainnet" | "testnet";

export interface TatumSuiOptions {
  network: SuiNetwork;
  apiKey: string;
  /** gRPC base URL. Defaults to `https://sui-<network>-grpc.gateway.tatum.io`. */
  url?: string;
  /** Per-call deadline. */
  timeoutMs?: number;
  /** Unary calls per second. Tatum's gateway answers 429 above the plan's limit (3/s is safe on free). */
  maxRps?: number;
}

export function tatumGrpcUrl(network: SuiNetwork): string {
  return `https://sui-${network}-grpc.gateway.tatum.io`;
}

/**
 * Tatum serves native gRPC (`application/grpc`), not gRPC-web, so Node needs the grpc-js transport
 * instead of SuiGrpcClient's default (ADR-0021). The API key rides as `x-api-key` metadata.
 */
export function createTatumTransport(opts: TatumSuiOptions): GrpcTransport {
  const url = new URL(opts.url ?? tatumGrpcUrl(opts.network));
  return new GrpcTransport({
    host: `${url.hostname}:${url.port || 443}`,
    channelCredentials: ChannelCredentials.createSsl(),
    meta: { "x-api-key": opts.apiKey },
    timeout: opts.timeoutMs ?? 30_000,
  });
}

export function createTatumSuiClient(opts: TatumSuiOptions): SuiGrpcClient {
  const transport = new PacedTransport(createTatumTransport(opts), { maxRps: opts.maxRps ?? 3 });
  return new SuiGrpcClient({ network: opts.network, transport });
}

/** Reads the `.env.example` keys: `TATUM_SUI_GRPC[_TESTNET]` and `TATUM_API_KEY[_TESTNET]`. */
export function tatumSuiOptionsFromEnv(
  network: SuiNetwork,
  env: Record<string, string | undefined> = process.env,
): TatumSuiOptions {
  const suffix = network === "testnet" ? "_TESTNET" : "";
  const apiKey = env[`TATUM_API_KEY${suffix}`];
  if (!apiKey) throw new Error(`TATUM_API_KEY${suffix} is not set`);
  return { network, apiKey, url: env[`TATUM_SUI_GRPC${suffix}`] || undefined };
}

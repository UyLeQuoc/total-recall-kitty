import { normalizeSuiAddress } from "@mysten/sui/utils";

/** USDC has 6 decimals; the API sends micro-dollars. */
export const usd = (micro: string | number | bigint | null | undefined) =>
  `$${(Number(micro ?? 0) / 1e6).toFixed(2)}`;

export const toMicro = (dollars: number) => Math.round(dollars * 1e6);

export const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && normalizeSuiAddress(a) === normalizeSuiAddress(b);

export function windowLabel(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes === 60) return "hour";
  if (minutes === 60 * 24) return "day";
  if (minutes === 60 * 24 * 7) return "week";
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} min`;
}

export const txUrl = (digest: string) => `https://suiscan.xyz/testnet/tx/${digest}`;
export const objectUrl = (id: string) => `https://suiscan.xyz/testnet/object/${id}`;
/** Kitty's memories live on the mainnet Walrus Memory relayer (ADR-0062). */
export const blobUrl = (blobId: string) => `https://walruscan.com/mainnet/blob/${blobId}`;
export const FAUCET = "https://faucet.circle.com";

/** Memory texts carry full addresses for the record; on screen they're shortened. */
export const pretty = (text: string) => text.replace(/0x[0-9a-fA-F]{64}/g, (a) => short(a));

/** The aborts a pull can hit, in the contract's words (`pot.move`, `0x2::allowance`). */
const ABORTS: Record<string, string> = {
  EClosed: "the pot is closed",
  EExceedsRateLimit: "above the member's cap for this window",
  ENotMember: "not an active member",
  EWrongAllowance: "not this member's allowance",
};

/** A pull's reason; an aborted one says why in plain words. */
export function pullReason(status: string, reason: string) {
  if (status !== "aborted") return pretty(reason);
  const code = /'(E[A-Z][a-z][A-Za-z0-9]*)'/.exec(reason)?.[1];
  return `The chain refused it${code ? `: ${ABORTS[code] ?? code}` : ""}. Nothing moved.`;
}

/**
 * Kitty's API, typed for the web. Amounts are USDC micro-dollars as strings (the server's bigints).
 *
 * `useSponsored` is the wallet flow (ADR-0064): the server builds the whole transaction, the wallet signs
 * it, and the server adds the sponsor's signature and sends it. The member never needs SUI.
 */
import { useCurrentAccount, useSignTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

export interface Memory {
  id: string;
  text: string;
  blobId: string | null;
}

export interface Pot {
  id: string;
  name: string;
  goal: string;
  deadline: string;
  keeper: string;
  quorum: number;
  autoOkCap: string;
  windowMs: number;
  createDigest: string;
  closed: boolean;
  createdAt: string;
}

export interface PotSummary extends Pot {
  totalIn: string;
  members: number;
}

export interface Member {
  address: string;
  name: string;
  test: boolean;
  active: boolean;
  capPerWindow: string;
  contributed: string;
  nextPullAt: string | null;
  joinDigest: string;
  reason: Memory | null;
}

export interface Proposal {
  seq: number;
  kind: "spend" | "auto_cap" | "close";
  payee: string | null;
  amount: string | null;
  memo: string | null;
  proposer: string;
  approvals: { member: string; at: string }[];
  executed: boolean;
  digest: string | null;
  createdAt: string;
}

export interface Pull {
  id: string;
  member: string;
  amount: string;
  status: "sent" | "skipped" | "aborted" | string;
  digest: string | null;
  reason: string;
  createdAt: string;
  memory: Memory | null;
}

export interface PotDetail {
  pot: Pot;
  onchain: {
    balance: string;
    totalIn: string;
    totalOut: string;
    autoOkCap: string;
    closed: boolean;
  } | null;
  totalIn: string;
  members: Member[];
  proposals: Proposal[];
  pulls: Pull[];
  suggestion: { category: string; cap: string; n: number; memory: Memory | null } | null;
}

export interface StoredMemory {
  id: string;
  namespace: string;
  kind: string;
  text: string;
  blobId: string | null;
  status: string;
  createdAt: string;
}

export interface WalletInfo {
  address: string;
  usdc: { addressBalance: string; coinBalance: string };
  test: boolean;
  /** The pots this wallet joined, newest first. */
  pots: { potId: string; name: string; active: boolean; closed: boolean }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: string; message?: string })
    | null;
  if (!res.ok)
    throw new ApiError(
      res.status,
      body?.error ?? "error",
      body?.message ?? `Kitty's server answered ${res.status}.`,
    );
  return body as T;
}

export const api = {
  get: <T>(path: string) => call<T>(path),
  post: <T>(path: string, body: unknown) =>
    call<T>(path, { method: "POST", body: JSON.stringify(body) }),
};

export const usePots = () =>
  useQuery({
    queryKey: ["pots"],
    queryFn: () => api.get<PotSummary[]>("/api/pots"),
    refetchInterval: 30_000,
  });

export const usePot = (id: string) =>
  useQuery({
    queryKey: ["pot", id],
    queryFn: () => api.get<PotDetail>(`/api/pots/${id}`),
    refetchInterval: 15_000,
  });

export const useMemories = (id: string) =>
  useQuery({
    queryKey: ["memories", id],
    queryFn: () => api.get<StoredMemory[]>(`/api/pots/${id}/memories`),
    refetchInterval: 30_000,
  });

export const useWallet = (address: string | undefined) =>
  useQuery({
    queryKey: ["wallet", address],
    queryFn: () => api.get<WalletInfo>(`/api/wallet/${address}`),
    enabled: !!address,
    refetchInterval: 20_000,
  });

/** What the member asks Kitty to build; the server checks it again. */
export type Prepare =
  | {
      action: "create";
      name: string;
      goalUsd: number;
      deadline: string;
      quorum: number;
      autoOkUsd: number;
      windowMinutes: number;
    }
  | { action: "join"; potId: string; name: string; capUsd: number }
  | {
      action: "propose";
      potId: string;
      kind: "spend" | "auto_cap" | "close";
      payee?: string;
      amountUsd?: number;
      memo?: string;
      capUsd?: number;
    }
  | { action: "approve"; potId: string; seq: number }
  | { action: "leave"; potId: string }
  | { action: "deposit" };

export type Step = "idle" | "building" | "signing" | "sending";

export const stepLabel: Record<Step, string> = {
  idle: "",
  building: "Kitty is building the transaction…",
  signing: "Confirm in your wallet…",
  sending: "Sending (gas is on Kitty)…",
};

/** Builds on the server, signs in the wallet, sends sponsored. One per form, so each shows its own step. */
export function useSponsored() {
  const account = useCurrentAccount();
  const sign = useSignTransaction();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);

  /** `throws` is for a confirm dialog that shows the error itself (ConfirmAction). */
  async function run<T extends { digest: string }>(
    body: Prepare,
    opts?: { throws?: boolean },
  ): Promise<T | null> {
    if (!account) {
      setError("Connect a wallet first.");
      return null;
    }
    setError(null);
    try {
      setStep("building");
      const prepared = await api.post<{ bytes: string; digest: string }>("/api/tx/prepare", {
        ...body,
        sender: account.address,
      });
      setStep("signing");
      const signed = await sign.mutateAsync({ transaction: Transaction.from(prepared.bytes) });
      setStep("sending");
      const result = await api.post<T>("/api/tx/execute", {
        digest: prepared.digest,
        signature: signed.signature,
        bytes: signed.bytes,
      });
      await qc.invalidateQueries();
      return result;
    } catch (err) {
      const message = readable(err);
      setError(message);
      if (opts?.throws) throw new Error(message);
      return null;
    } finally {
      setStep("idle");
    }
  }

  return { run, step, busy: step !== "idle", error, clearError: () => setError(null) };
}

function readable(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  const text = err instanceof Error ? err.message : String(err);
  if (/reject|denied|cancel/i.test(text)) return "You cancelled in your wallet. Nothing was sent.";
  return text;
}

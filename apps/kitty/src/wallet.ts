/**
 * A member's wallet as the signer of a sponsored transaction (ADR-0064), over two HTTP calls.
 *
 * `start` runs an action (actions.ts) with a signer that stops at the signature: the server has built
 * the whole transaction (the member is the sender, the sponsor the gas owner), so `start` answers with
 * the bytes and their digest. The web asks the wallet to sign them and calls `finish`, which hands the
 * signature to the waiting action. The action then checks it, adds the sponsor's signature, executes and
 * records the result, exactly as with a key Kitty holds.
 *
 * A build that would abort fails inside `start`, before any signature is asked for. An entry nobody
 * finishes expires after `ttlMs`, and its action ends without sending anything.
 */
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import type { Signer } from "./chain.ts";

export class WalletSessionError extends Error {
  constructor(
    readonly code: "expired" | "busy" | "wrong_bytes" | "nothing_to_sign",
    message: string,
  ) {
    super(message);
  }
}

export interface Prepared {
  /** The transaction to sign, base64 (the full `TransactionData`, gas included). */
  bytes: string;
  digest: string;
  sender: string;
}

interface Pending {
  bytes: string;
  sign(signature: string): void;
  result: Promise<unknown>;
}

export interface WalletSessions {
  start<T>(sender: string, act: (signer: Signer) => Promise<T>): Promise<Prepared>;
  /** `bytes`, when the wallet returns them, must be the bytes that were prepared. */
  finish(digest: string, signature: string, bytes?: string): Promise<unknown>;
  readonly size: number;
}

export function createWalletSessions(opts: { ttlMs?: number; max?: number } = {}): WalletSessions {
  const ttlMs = opts.ttlMs ?? 120_000;
  const max = opts.max ?? 50;
  const pending = new Map<string, Pending>();

  return {
    get size() {
      return pending.size;
    },
    start(sender, act) {
      if (pending.size >= max)
        return Promise.reject(new WalletSessionError("busy", "Too many unsigned transactions."));
      const address = normalizeSuiAddress(sender);
      return new Promise<Prepared>((prepared, refused) => {
        let asked = false;
        const signer: Signer = {
          toSuiAddress: () => address,
          signTransaction(raw) {
            if (asked)
              return Promise.reject(
                new WalletSessionError("busy", "One wallet signature per action."),
              );
            asked = true;
            const digest = TransactionDataBuilder.getDigestFromBytes(raw);
            const bytes = toBase64(raw);
            return new Promise<{ signature: string }>((signed, expired) => {
              const timer = setTimeout(() => {
                pending.delete(digest);
                expired(new WalletSessionError("expired", "The wallet didn't sign in time."));
              }, ttlMs);
              pending.set(digest, {
                bytes,
                sign(signature) {
                  clearTimeout(timer);
                  signed({ signature });
                },
                result,
              });
              prepared({ bytes, digest, sender: address });
            });
          },
        };
        const result: Promise<unknown> = act(signer);
        result.then(
          () => {
            if (!asked)
              refused(new WalletSessionError("nothing_to_sign", "Nothing for the wallet to sign."));
          },
          (err) => {
            // Before the signature: the build failed (an abort, a bad argument). Answer `start` with it.
            if (!asked) refused(err);
          },
        );
        // After the signature, `finish` awaits the result; an expired one ends here, unsent.
        result.catch(() => {});
      });
    },
    async finish(digest, signature, bytes) {
      const p = pending.get(digest);
      if (!p)
        throw new WalletSessionError(
          "expired",
          "Nothing waits for this signature. Prepare the transaction again.",
        );
      if (bytes !== undefined && bytes !== p.bytes)
        throw new WalletSessionError(
          "wrong_bytes",
          "The wallet signed different bytes from the ones Kitty built.",
        );
      pending.delete(digest);
      p.sign(signature);
      return p.result;
    },
  };
}

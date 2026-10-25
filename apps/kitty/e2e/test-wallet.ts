/**
 * An injected wallet-standard test wallet, copied from Remora's `e2e/support/test-wallet.ts` (ADR-0060:
 * copy, don't import across apps). The page gets a wallet whose signing calls go back to Node through
 * `page.exposeFunction`, so the test key never enters the browser. Testnet only, and only Kitty's
 * generated test members' keys (never a real owner's wallet).
 */
import type { Keypair } from "@mysten/sui/cryptography";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import type { Page } from "@playwright/test";

export async function installTestWallet(
  page: Page,
  kp: Keypair,
  name: string,
  client: SuiGrpcClient,
): Promise<{ signed: string[] }> {
  const signed: string[] = [];
  const address = kp.toSuiAddress();
  await page.exposeFunction("__kittyE2eSignTx", async (json: string, chain: string) => {
    if (chain !== "sui:testnet")
      throw new Error(`the test wallet only signs on testnet, not ${chain}`);
    const tx = Transaction.from(json);
    tx.setSenderIfNotSet(address);
    const bytes = await tx.build({ client });
    const { signature } = await kp.signTransaction(bytes);
    signed.push(signature);
    return { bytes: toBase64(bytes), signature };
  });
  await page.addInitScript(
    ({ name, address, publicKey }) => {
      const account = {
        address,
        publicKey: new Uint8Array(publicKey),
        chains: ["sui:testnet"] as const,
        features: ["sui:signTransaction"],
        label: name,
      };
      const icon =
        "data:image/svg+xml;base64," +
        btoa(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#0ea5e9"/></svg>',
        );
      const w = window as unknown as Record<
        string,
        (...a: unknown[]) => Promise<{ bytes: string; signature: string }>
      >;
      const wallet = {
        version: "1.0.0",
        name,
        icon,
        chains: ["sui:testnet"],
        get accounts() {
          return [account];
        },
        features: {
          "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
          "standard:disconnect": { version: "1.0.0", disconnect: async () => {} },
          "standard:events": { version: "1.0.0", on: () => () => {} },
          "sui:signTransaction": {
            version: "2.0.0",
            signTransaction: async ({
              transaction,
              chain,
            }: {
              transaction: { toJSON(): Promise<string> };
              chain: string;
            }) => w.__kittyE2eSignTx?.(await transaction.toJSON(), chain),
          },
        },
      };
      const register = ({ register }: { register: (w: unknown) => void }) => register(wallet);
      window.addEventListener("wallet-standard:app-ready", (e) =>
        register((e as CustomEvent).detail),
      );
      window.dispatchEvent(
        new CustomEvent("wallet-standard:register-wallet", { detail: register }),
      );
    },
    { name, address, publicKey: Array.from(kp.getPublicKey().toRawBytes()) },
  );
  return { signed };
}

/** Connects through dapp-kit's own button and modal. */
export async function connect(page: Page, name: string) {
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 30_000 });
}

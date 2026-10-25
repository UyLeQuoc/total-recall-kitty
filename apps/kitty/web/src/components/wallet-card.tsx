/**
 * "Get ready": Kitty pulls from the wallet's address balance, not its coins. Coins can be moved there
 * with one sponsored signature; an empty wallet gets the faucet.
 */
import { useCurrentAccount } from "@mysten/dapp-kit";
import { useState } from "react";
import { Link } from "react-router";
import { useSponsored, useWallet } from "../api.ts";
import { FAUCET, short, usd } from "../format.ts";
import { Badge, Button, Card, Status, TxLink } from "./ui.tsx";

export function WalletCard() {
  const account = useCurrentAccount();
  const wallet = useWallet(account?.address);
  const deposit = useSponsored();
  const [moved, setMoved] = useState<string | null>(null);
  if (!account) return null;
  const w = wallet.data;
  const inBalance = Number(w?.usdc.addressBalance ?? 0);
  const inCoins = Number(w?.usdc.coinBalance ?? 0);

  return (
    <Card tone="brand">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          Your wallet{" "}
          <span className="font-mono text-sm font-normal">{short(account.address)}</span>
        </h2>
        {w?.test ? <Badge tone="test">test key</Badge> : null}
      </div>
      {wallet.isLoading ? (
        <p className="mt-2 text-sm text-stone-500">Reading your USDC…</p>
      ) : (
        <div className="mt-2 space-y-2 text-sm">
          <p>
            Kitty can pull from <strong>{usd(inBalance)}</strong> of test USDC in your balance.
          </p>
          {inCoins > 0 ? (
            <div className="space-y-2">
              <p>
                You also hold <strong>{usd(inCoins)}</strong> in USDC coins. Kitty pulls only from
                your balance, so move them there first: one signature, gas on Kitty.
              </p>
              <Button
                disabled={deposit.busy}
                onClick={async () => {
                  const r = await deposit.run<{ digest: string; coins: number }>({
                    action: "deposit",
                  });
                  if (r) {
                    setMoved(r.digest);
                    await wallet.refetch();
                  }
                }}
              >
                Move {usd(inCoins)} to my balance
              </Button>
            </div>
          ) : inBalance === 0 ? (
            <p>
              No test USDC yet. Get some from{" "}
              <a
                className="font-medium text-brand-700 underline dark:text-brand-300"
                href={FAUCET}
                target="_blank"
                rel="noreferrer"
              >
                Circle's faucet
              </a>{" "}
              (pick Sui testnet), then come back and move it into your balance.
            </p>
          ) : null}
          <Status step={deposit.step} error={deposit.error} />
          {moved ? (
            <p className="text-emerald-700 dark:text-emerald-300">
              Moved into your balance. <TxLink digest={moved} />
            </p>
          ) : null}
          {w?.pots.length ? (
            <p>
              Your pots:{" "}
              {w.pots.map((p, i) => (
                <span key={p.potId}>
                  {i ? ", " : ""}
                  <Link
                    className="font-medium text-brand-700 underline dark:text-brand-300"
                    to={`/pots/${p.potId}`}
                  >
                    {p.name}
                  </Link>
                  {p.closed ? " (closed)" : p.active ? "" : " (left)"}
                </span>
              ))}
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}

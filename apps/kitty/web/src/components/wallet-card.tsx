/**
 * "Get ready": Kitty pulls from the wallet's address balance, not its coins. Coins can be moved there
 * with one sponsored signature; an empty wallet gets the faucet.
 */
import { useCurrentAccount } from "@mysten/dapp-kit";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { useSponsored, useWallet } from "@/api";
import { Done, TxStatus } from "@/components/kitty";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FAUCET, short, usd } from "@/format";

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
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Your wallet
          <span className="font-mono text-sm font-normal text-muted-foreground">
            {short(account.address)}
          </span>
          {w?.test ? <Badge variant="secondary">test key</Badge> : null}
        </CardTitle>
        <CardDescription>
          {wallet.isLoading ? (
            <Skeleton className="h-4 w-56" />
          ) : (
            <>
              Kitty can pull from{" "}
              <span className="font-semibold text-foreground tabular-nums">{usd(inBalance)}</span>{" "}
              of test USDC in your balance.
            </>
          )}
        </CardDescription>
      </CardHeader>
      {wallet.isLoading ? null : (
        <CardContent className="flex flex-col gap-3 text-sm">
          {inCoins > 0 ? (
            <>
              <p>
                You also hold <strong className="tabular-nums">{usd(inCoins)}</strong> in USDC
                coins. Kitty pulls only from your balance, so move them there first: one signature,
                gas on Kitty.
              </p>
              <div>
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
            </>
          ) : inBalance === 0 ? (
            <p>
              No test USDC yet. Get some from{" "}
              <a
                className="inline-flex items-center gap-0.5 font-medium text-primary underline-offset-4 hover:underline"
                href={FAUCET}
                target="_blank"
                rel="noreferrer"
              >
                Circle's faucet
                <ArrowUpRight aria-hidden className="size-3.5" />
              </a>{" "}
              (pick Sui testnet), then come back and move it into your balance.
            </p>
          ) : null}
          <TxStatus step={deposit.step} error={deposit.error} />
          {moved ? <Done digest={moved}>Moved into your balance.</Done> : null}
        </CardContent>
      )}
    </Card>
  );
}

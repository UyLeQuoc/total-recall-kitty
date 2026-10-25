/**
 * "Connect wallet": a dialog listing the Sui wallets in this browser, as in Remora
 * (apps/web/src/components/wallet-picker.tsx, ADR-0066). Kitty has no sign-in: connecting is enough,
 * because every action is a transaction the wallet signs.
 */
import { useConnectWallet, useWallets } from "@mysten/dapp-kit";
import { type ComponentProps, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function WalletPicker({
  label = "Connect wallet",
  className,
  variant,
  size,
}: {
  label?: string;
  className?: string;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
}) {
  const [open, setOpen] = useState(false);
  const wallets = useWallets();
  const connect = useConnectWallet();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Choose a wallet</DialogTitle>
            <DialogDescription>
              Slush, or any other Sui wallet in this browser, on testnet. Kitty pays the gas.
            </DialogDescription>
          </DialogHeader>
          {wallets.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No wallet found. Install Slush or another Sui wallet, then reload this page.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {wallets.map((wallet) => (
                <Button
                  key={wallet.name}
                  type="button"
                  variant="outline"
                  disabled={connect.isPending}
                  onClick={() =>
                    connect.mutate(
                      { wallet },
                      {
                        onSuccess: () => setOpen(false),
                        onError: (err) => setError(err.message || "The wallet didn't connect."),
                      },
                    )
                  }
                >
                  {wallet.icon ? (
                    <img src={wallet.icon} alt="" className="size-5 rounded-sm" />
                  ) : null}
                  {wallet.name}
                </Button>
              ))}
            </div>
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

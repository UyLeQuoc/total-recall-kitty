/**
 * The sidebar's footer, as in Remora (apps/web/src/components/app/account-menu.tsx, ADR-0066).
 * Connected, it's the wallet: its avatar, address and the USDC Kitty can pull, with a menu for the
 * address, the theme, the faucet and disconnecting. Otherwise it's "Connect wallet" plus a small menu.
 */
import { useCurrentAccount, useDisconnectWallet } from "@mysten/dapp-kit";
import { ArrowUpRight, LogOut, MoreHorizontal } from "lucide-react";
import { useWallet } from "@/api";
import { ThemeChoice } from "@/components/app/theme-choice";
import { WalletAvatar } from "@/components/app/wallet-avatar";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WalletPicker } from "@/components/wallet-picker";
import { FAUCET, short, usd } from "@/format";

function FaucetItem() {
  return (
    <DropdownMenuItem asChild>
      <a href={FAUCET} target="_blank" rel="noreferrer">
        Get test USDC <ArrowUpRight className="ml-auto" />
      </a>
    </DropdownMenuItem>
  );
}

export function AccountMenu() {
  const account = useCurrentAccount();
  const wallet = useWallet(account?.address);
  const disconnect = useDisconnectWallet();

  if (!account) {
    return (
      <div className="flex w-full items-center gap-1">
        <WalletPicker className="flex-1 group-data-[collapsible=icon]:hidden" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="More"
              className="text-muted-foreground"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <ThemeChoice />
            <DropdownMenuSeparator />
            <FaucetItem />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  const address = account.address;
  const balance = wallet.data ? `${usd(wallet.data.usdc.addressBalance)} USDC` : "…";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          aria-label="Your wallet"
          className="h-auto w-full justify-start gap-2 px-2 py-1.5"
        >
          <span className="shrink-0">
            <WalletAvatar address={address} />
          </span>
          <span className="min-w-0 flex-1 text-left text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            <span className="block truncate font-mono">{short(address)}</span>
            <span className="block truncate tabular-nums">{balance}</span>
          </span>
          <MoreHorizontal className="size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-1 font-normal">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={address}>
              {short(address)}
            </span>
            <CopyButton value={address} label="address" variant="ghost" size="icon-sm" />
          </span>
          <span className="text-xs text-muted-foreground">
            {balance} Kitty can pull{wallet.data?.test ? " · test key" : ""}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ThemeChoice />
        <FaucetItem />
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => disconnect.mutate()}>
          <LogOut /> Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

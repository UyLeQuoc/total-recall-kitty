import { ConnectButton } from "@mysten/dapp-kit";
import { Link, Outlet } from "react-router";
import { Badge } from "./ui.tsx";

export function Shell() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b border-stone-200 bg-stone-50/85 backdrop-blur dark:border-stone-800 dark:bg-stone-950/85">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <span aria-hidden>🐱</span> Kitty
            <Badge tone="brand">testnet</Badge>
          </Link>
          <ConnectButton connectText="Connect wallet" />
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <footer className="mx-auto w-full max-w-3xl px-4 pb-8 text-xs text-stone-500">
        Sui testnet, test USDC only. Kitty sponsors the gas, so your wallet needs no SUI. Kitty's
        reasons are memories on Walrus (mainnet).
      </footer>
    </div>
  );
}

import { useCurrentAccount } from "@mysten/dapp-kit";
import { useState } from "react";
import { Link } from "react-router";
import { usePots } from "../api.ts";
import { StartPot } from "../components/start-pot.tsx";
import { Badge, Button, Card, Progress } from "../components/ui.tsx";
import { WalletCard } from "../components/wallet-card.tsx";
import { usd, when } from "../format.ts";

export function Home() {
  const account = useCurrentAccount();
  const pots = usePots();
  const [starting, setStarting] = useState(false);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          The group pot that saves itself
        </h1>
        <p className="text-stone-600 dark:text-stone-400">
          Everyone signs once. Kitty pulls each share right after that person's payday, never more
          than the cap they set, and spends only the way the group agreed. A Move contract holds the
          pot, not a friend.
        </p>
      </div>

      <WalletCard />

      {starting ? (
        <StartPot onClose={() => setStarting(false)} />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => setStarting(true)} disabled={!account}>
            Start a pot
          </Button>
          {account ? null : (
            <span className="text-sm text-stone-500">Connect a wallet to start or join a pot.</span>
          )}
        </div>
      )}

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Pots</h2>
        {pots.isLoading ? <p className="text-sm text-stone-500">Loading…</p> : null}
        {pots.error ? (
          <p className="text-sm text-rose-700">Kitty's server didn't answer. Is it running?</p>
        ) : null}
        {pots.data?.length === 0 ? <p className="text-sm text-stone-500">No pots yet.</p> : null}
        <div className="grid gap-3">
          {pots.data?.map((p) => {
            const pct = Number(p.goal) > 0 ? (Number(p.totalIn) / Number(p.goal)) * 100 : 0;
            return (
              <Link key={p.id} to={`/pots/${p.id}`} className="group block">
                <Card className="transition group-hover:border-brand-300 group-hover:shadow-md">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-semibold group-hover:text-brand-700">{p.name}</span>
                    <span className="text-sm text-stone-500">
                      {usd(p.totalIn)} of {usd(p.goal)}
                    </span>
                  </div>
                  <div className="mt-2">
                    <Progress value={pct} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                    <span>
                      {p.members} {p.members === 1 ? "member" : "members"}
                    </span>
                    <span>·</span>
                    <span>by {when(p.deadline)}</span>
                    {p.closed ? <Badge>closed</Badge> : null}
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

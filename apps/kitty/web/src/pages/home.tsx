import { useCurrentAccount } from "@mysten/dapp-kit";
import { PiggyBank, Plus } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { usePots } from "@/api";
import { EmptyState } from "@/components/app/empty-state";
import { Page, PageHeader, Section } from "@/components/app/page";
import { StartPot } from "@/components/start-pot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { WalletCard } from "@/components/wallet-card";
import { WalletPicker } from "@/components/wallet-picker";
import { usd, when } from "@/format";

export function Home() {
  const account = useCurrentAccount();
  const pots = usePots();
  const [params, setParams] = useSearchParams();
  const starting = params.has("start") && !!account;
  const setStarting = (on: boolean) => setParams(on ? { start: "1" } : {}, { replace: true });

  return (
    <Page title="Kitty">
      <PageHeader
        title="The group pot that saves itself"
        description="Everyone signs once. Kitty pulls each share right after that person's payday, never more than the cap they set, and spends only the way the group agreed. A Move contract holds the pot, not a friend."
        actions={
          starting ? null : account ? (
            <Button onClick={() => setStarting(true)}>
              <Plus />
              Start a pot
            </Button>
          ) : (
            <WalletPicker label="Connect a wallet to start" />
          )
        }
      />

      <WalletCard />

      {starting ? <StartPot onClose={() => setStarting(false)} /> : null}

      <Section title="Pots" description="Every pot on this Kitty, newest first.">
        {pots.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
          </div>
        ) : null}
        {pots.error ? (
          <p className="text-sm text-destructive">Kitty's server didn't answer. Is it running?</p>
        ) : null}
        {pots.data?.length === 0 ? (
          <EmptyState
            icon={<PiggyBank />}
            title="No pots yet"
            description="Start one for a trip or a house fund, then send the link to your friends."
          />
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {pots.data?.map((p) => {
            const pct = Number(p.goal) > 0 ? (Number(p.totalIn) / Number(p.goal)) * 100 : 0;
            return (
              <Link
                key={p.id}
                to={`/pots/${p.id}`}
                className="group rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Card className="h-full gap-3 p-4 transition-colors group-hover:border-primary/40">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 font-medium break-words">{p.name}</span>
                    {p.closed ? <Badge variant="outline">closed</Badge> : null}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    <span className="font-semibold text-foreground tabular-nums">
                      {usd(p.totalIn)}
                    </span>{" "}
                    of {usd(p.goal)}
                  </p>
                  <Progress
                    value={Math.min(100, pct)}
                    aria-label={`${Math.round(pct)}% of the goal`}
                  />
                  <p className="text-sm text-muted-foreground">
                    {p.members} {p.members === 1 ? "member" : "members"} · by {when(p.deadline)}
                  </p>
                </Card>
              </Link>
            );
          })}
        </div>
      </Section>
    </Page>
  );
}

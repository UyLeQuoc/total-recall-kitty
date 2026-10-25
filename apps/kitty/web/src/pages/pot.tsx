/**
 * The pot page (KT3, ADR-0064, in Remora's design, ADR-0066): progress, the connected wallet's own
 * status (join with one signature, or leave), Kitty's suggested auto-ok rule, members with their next
 * pull and 🧠 reason, proposals with approve, and Kitty's pulls. Every action is the member's own
 * signature; Kitty pays the gas.
 */
import { useCurrentAccount } from "@mysten/dapp-kit";
import { ArrowLeft, Brain, Coins, Plus, Users } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { type Member, type PotDetail, type Proposal, usePot, useSponsored } from "@/api";
import { ConfirmAction } from "@/components/app/confirm-action";
import { EmptyState } from "@/components/app/empty-state";
import { Page, PageHeader, Section } from "@/components/app/page";
import { StatTile } from "@/components/app/stat-tile";
import { Done, Field, MemoryChip, TxLink, TxStatus } from "@/components/kitty";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { WalletPicker } from "@/components/wallet-picker";
import { pullReason, same, short, usd, when, windowLabel } from "@/format";

export function PotPage() {
  const { id = "" } = useParams();
  const [search] = useSearchParams();
  const pot = usePot(id);
  const account = useCurrentAccount();

  if (pot.isLoading)
    return (
      <Page title="Pot">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 rounded-xl" />
      </Page>
    );
  if (pot.error || !pot.data)
    return (
      <Page title="No such pot">
        <EmptyState
          icon={<Coins />}
          title="No such pot"
          description="This link doesn't match a pot on this Kitty."
          action={
            <Button asChild variant="outline">
              <Link to="/">Back to the pots</Link>
            </Button>
          }
        />
      </Page>
    );

  const d = pot.data;
  const me = d.members.find((m) => same(m.address, account?.address));
  const created = search.get("created");

  return (
    <Page title={d.pot.name}>
      <div className="flex flex-col gap-3">
        <Link
          to="/"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-4" />
          All pots
        </Link>
        <PageHeader
          title={d.pot.name}
          badge={
            d.pot.closed ? (
              <Badge variant="outline">closed</Badge>
            ) : (
              <Badge variant="success">open</Badge>
            )
          }
          description={
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <Link
                className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
                to={`/pots/${id}/learned`}
              >
                <Brain aria-hidden className="size-4" />
                What Kitty learned
              </Link>
              <TxLink digest={d.pot.createDigest} label="created on Sui" />
            </span>
          }
        />
      </div>

      {created ? (
        <Alert variant="success">
          <AlertDescription>
            <p>
              Your pot is on Sui. <TxLink digest={created} /> Now join it below, and send the link
              to your friends.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <Overview d={d} />
      <You d={d} me={me} />
      <Suggestion d={d} me={me} />
      <Members d={d} me={me} />
      <Proposals d={d} me={me} />
      <Pulls d={d} />
    </Page>
  );
}

function Overview({ d }: { d: PotDetail }) {
  const goal = Number(d.pot.goal);
  const pct = goal > 0 ? (Number(d.totalIn) / goal) * 100 : 0;
  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-3 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-3xl font-semibold tabular-nums">
            {usd(d.totalIn)}{" "}
            <span className="text-base font-normal text-muted-foreground">of {usd(goal)}</span>
          </p>
          <p className="text-sm text-muted-foreground">by {when(d.pot.deadline)}</p>
        </div>
        <Progress value={Math.min(100, pct)} aria-label={`${Math.round(pct)}% of the goal`} />
      </Card>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="In the pot now" value={d.onchain ? usd(d.onchain.balance) : "…"} />
        <StatTile label="Spent" value={d.onchain ? usd(d.onchain.totalOut) : "…"} />
        <StatTile label="Approvals to spend" value={d.pot.quorum} />
        <StatTile label="Auto-ok up to" value={usd(d.onchain?.autoOkCap ?? d.pot.autoOkCap)} />
      </div>
    </div>
  );
}

function You({ d, me }: { d: PotDetail; me: Member | undefined }) {
  const account = useCurrentAccount();
  const tx = useSponsored();
  const [name, setName] = useState("");
  const [cap, setCap] = useState("0.40");
  const [done, setDone] = useState<string | null>(null);

  if (!account)
    return (
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Connect a wallet to join this pot, propose a spend or approve one.
          </p>
          <WalletPicker label="Connect a wallet" variant="outline" />
        </div>
      </Card>
    );

  if (me?.active)
    return (
      <Card className="border-primary/30 bg-accent/40">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            You're in as {me.name} {me.test ? <Badge variant="secondary">test</Badge> : null}
          </CardTitle>
          <CardDescription>
            {d.pot.closed
              ? "The pot is closed: what wasn't spent went back to the members pro rata, and Kitty pulls no more."
              : `Kitty may pull at most ${usd(me.capPerWindow)} per ${windowLabel(d.pot.windowMs)} from your USDC balance, until ${when(d.pot.deadline)}. Next pull: ${me.nextPullAt ? when(me.nextPullAt) : "when it's due"}. You've put in ${usd(me.contributed)}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {me.reason ? <MemoryChip memory={me.reason} label="Why:" /> : null}
          {d.pot.closed ? null : (
            <div>
              <ConfirmAction
                trigger={
                  <Button variant="outline" disabled={tx.busy}>
                    Leave…
                  </Button>
                }
                title="Leave the pot?"
                description="Your allowance is revoked, so Kitty can't pull from you again. What you put in stays in the pot and comes back pro rata when it closes. Your wallet signs; Kitty pays the gas."
                confirmLabel="Leave the pot"
                onConfirm={async () => {
                  const r = await tx.run({ action: "leave", potId: d.pot.id }, { throws: true });
                  if (r) setDone(r.digest);
                }}
              />
            </div>
          )}
          {done ? <Done digest={done}>Done.</Done> : null}
        </CardContent>
      </Card>
    );

  if (me && !me.active)
    return (
      <Card className="p-5">
        <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          You left this pot. Kitty no longer pulls from you.{" "}
          {done ? <TxLink digest={done} label="left" /> : null}
        </p>
      </Card>
    );

  if (d.pot.closed)
    return (
      <Card className="p-5">
        <p className="text-sm text-muted-foreground">This pot is closed.</p>
      </Card>
    );

  async function join(e: FormEvent) {
    e.preventDefault();
    const r = await tx.run({
      action: "join",
      potId: d.pot.id,
      name: name.trim(),
      capUsd: Number(cap),
    });
    if (r) setDone(r.digest);
  }

  return (
    <Card className="border-primary/30">
      <CardHeader>
        <CardTitle>Join with one signature</CardTitle>
        <CardDescription>
          You sign one allowance: Kitty's keeper may pull at most your cap per{" "}
          {windowLabel(d.pot.windowMs)} from your USDC balance, until {when(d.pot.deadline)}. Sui
          enforces the cap, not Kitty. You can leave any time. Gas is on Kitty.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={join} className="flex max-w-2xl flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Your name"
              required
              maxLength={40}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Field
              label={`Cap per ${windowLabel(d.pot.windowMs)} ($)`}
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              required
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
          </div>
          <TxStatus step={tx.step} error={tx.error} />
          <div>
            <Button type="submit" disabled={tx.busy || !name.trim()}>
              Join with one signature
            </Button>
          </div>
          {done ? <Done digest={done}>You joined.</Done> : null}
        </form>
      </CardContent>
    </Card>
  );
}

function Suggestion({ d, me }: { d: PotDetail; me: Member | undefined }) {
  const tx = useSponsored();
  const s = d.suggestion;
  if (!s) return null;
  return (
    <Card className="border-primary/30 bg-accent/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Brain aria-hidden className="size-4 text-primary" />
          Kitty suggests a rule
        </CardTitle>
        <CardDescription>
          Make {s.category} spends automatic up to {usd(s.cap)}. The group approved {s.n} of them,
          each within 10 minutes. Voting it in is a proposal like any other, and the contract
          enforces the result.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {s.memory ? <MemoryChip memory={s.memory} /> : null}
        {me?.active ? (
          <>
            <div>
              <Button
                disabled={tx.busy}
                onClick={() =>
                  tx.run({
                    action: "propose",
                    potId: d.pot.id,
                    kind: "auto_cap",
                    capUsd: Number(s.cap) / 1e6,
                  })
                }
              >
                Propose it
              </Button>
            </div>
            <TxStatus step={tx.step} error={tx.error} />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Members({ d, me }: { d: PotDetail; me: Member | undefined }) {
  return (
    <Section
      title="Members"
      description={`Each can be pulled at most their cap per ${windowLabel(d.pot.windowMs)}.`}
    >
      {d.members.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title="Nobody yet"
          description="Be the first to join, then send the link to your friends."
        />
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {d.members.map((m) => (
          <Card key={m.address} className="gap-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-medium">{m.name}</span>
                {m.test ? <Badge variant="secondary">test</Badge> : null}
                {same(m.address, me?.address) ? <Badge variant="accent">you</Badge> : null}
                {m.active ? null : <Badge variant="outline">left</Badge>}
                <span className="font-mono text-xs text-muted-foreground">{short(m.address)}</span>
              </div>
              <span className="text-sm text-muted-foreground">
                put in{" "}
                <span className="font-semibold text-foreground tabular-nums">
                  {usd(m.contributed)}
                </span>
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              Cap {usd(m.capPerWindow)} per {windowLabel(d.pot.windowMs)} · next pull{" "}
              {d.pot.closed
                ? "none (closed)"
                : m.active
                  ? m.nextPullAt
                    ? when(m.nextPullAt)
                    : "when due"
                  : "none (left)"}
            </p>
            {m.reason ? <MemoryChip memory={m.reason} /> : null}
          </Card>
        ))}
      </div>
    </Section>
  );
}

function describe(p: Proposal) {
  if (p.kind === "spend") return `${p.memo || "A spend"}: ${usd(p.amount)}`;
  if (p.kind === "auto_cap") return `Rule: spends up to ${usd(p.amount)} need no vote`;
  return "Close the pot and refund everyone pro rata";
}

function Proposals({ d, me }: { d: PotDetail; me: Member | undefined }) {
  const [open, setOpen] = useState(false);
  const active = d.members.filter((m) => m.active);
  const needed = Math.min(d.pot.quorum, active.length);
  const canPropose = !!me?.active && !d.pot.closed;
  return (
    <Section
      title="Proposals"
      description={`${needed} ${needed === 1 ? "approval" : "approvals"} to pass. A proposal counts as its author's approval.`}
      actions={
        canPropose && !open ? (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Plus />
            Propose a spend
          </Button>
        ) : null
      }
    >
      {canPropose && open ? <Propose d={d} onClose={() => setOpen(false)} /> : null}
      {d.proposals.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p> : null}
      <div className="grid gap-3">
        {d.proposals.map((p) => (
          <ProposalRow key={p.seq} d={d} p={p} me={me} needed={needed} />
        ))}
      </div>
    </Section>
  );
}

function ProposalRow({
  d,
  p,
  me,
  needed,
}: {
  d: PotDetail;
  p: Proposal;
  me: Member | undefined;
  needed: number;
}) {
  const tx = useSponsored();
  const nameOf = (a: string) => d.members.find((m) => same(m.address, a))?.name ?? short(a);
  const activeApprovals = p.approvals.filter((a) =>
    d.members.some((m) => m.active && same(m.address, a.member)),
  ).length;
  const approvedByMe = p.approvals.some((a) => same(a.member, me?.address));
  const canApprove = !!me?.active && !approvedByMe && !p.executed && !d.pot.closed;
  const passes = activeApprovals + 1 >= needed;
  return (
    <Card className="gap-2 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium break-words">
            <span className="text-muted-foreground">#{p.seq}</span> {describe(p)}
          </p>
          {p.kind === "spend" && p.payee ? (
            <p className="text-sm text-muted-foreground">to {nameOf(p.payee)}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {p.executed ? (
            <Badge variant="success">done</Badge>
          ) : (
            <Badge variant="warning">
              {activeApprovals} of {needed}
            </Badge>
          )}
          {p.digest ? <TxLink digest={p.digest} /> : null}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Approved by {p.approvals.map((a) => nameOf(a.member)).join(", ") || "nobody yet"}
      </p>
      {canApprove ? (
        <div className="flex flex-col gap-2 pt-1">
          <div>
            <Button
              size="sm"
              disabled={tx.busy}
              onClick={() => tx.run({ action: "approve", potId: d.pot.id, seq: p.seq })}
            >
              {passes ? (p.kind === "spend" ? "Approve and pay" : "Approve and apply") : "Approve"}
            </Button>
          </div>
          <TxStatus step={tx.step} error={tx.error} />
        </div>
      ) : null}
    </Card>
  );
}

function Propose({ d, onClose }: { d: PotDetail; onClose: () => void }) {
  const tx = useSponsored();
  const [memo, setMemo] = useState("");
  const [amount, setAmount] = useState("");
  const [payee, setPayee] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await tx.run({
      action: "propose",
      potId: d.pot.id,
      kind: "spend",
      memo: memo.trim(),
      amountUsd: Number(amount),
      payee: payee.trim(),
    });
    if (r) onClose();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Propose a spend</CardTitle>
        <CardDescription>
          Your proposal counts as your approval. It pays out when {d.pot.quorum}{" "}
          {d.pot.quorum === 1 ? "member approves" : "members approve"}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex max-w-2xl flex-col gap-4">
          <Field
            label="What for"
            required
            maxLength={80}
            placeholder="hotel one night"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            hint="The first word is the kind (food, hotel, …): Kitty learns the group's habits by kind."
          />
          <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <Field
              label="Amount ($)"
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <Field
              label="Pay to (Sui address)"
              required
              pattern="0x[0-9a-fA-F]{1,64}"
              placeholder="0x…"
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
            />
          </div>
          <TxStatus step={tx.step} error={tx.error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={tx.busy}>
              Propose it
            </Button>
            <Button type="button" variant="outline" disabled={tx.busy} onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

const PULL_BADGE = { sent: "success", skipped: "outline", aborted: "destructive" } as const;

function Pulls({ d }: { d: PotDetail }) {
  if (d.pulls.length === 0) return null;
  const nameOf = (a: string) => d.members.find((m) => same(m.address, a))?.name ?? short(a);
  return (
    <Section
      title="Kitty's pulls"
      description="Each one checks the member's balance first. A short member gets a memory, not a transaction."
    >
      <div className="grid gap-3">
        {d.pulls.map((p) => (
          <Card key={p.id} className="gap-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge variant={PULL_BADGE[p.status as keyof typeof PULL_BADGE] ?? "outline"}>
                  {p.status}
                </Badge>
                <span className="text-sm font-medium">
                  {nameOf(p.member)} · {usd(p.amount)}
                </span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {when(p.createdAt)}
                {p.digest ? <TxLink digest={p.digest} /> : null}
              </div>
            </div>
            <p className="text-sm break-words text-muted-foreground">
              {pullReason(p.status, p.reason)}
            </p>
            {p.memory ? <MemoryChip memory={p.memory} /> : null}
          </Card>
        ))}
      </div>
    </Section>
  );
}

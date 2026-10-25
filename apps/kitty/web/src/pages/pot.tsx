/**
 * The pot page (KT3, ADR-0064): progress, members with their next pull and 🧠 reason, the connected
 * wallet's own status (join with one signature, or leave), proposals with approve, and Kitty's suggested
 * auto-ok rule. Every action is the member's own signature; Kitty pays the gas.
 */
import { useCurrentAccount } from "@mysten/dapp-kit";
import { type FormEvent, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { type Member, type PotDetail, type Proposal, usePot, useSponsored } from "../api.ts";
import {
  Badge,
  Button,
  Card,
  Field,
  MemoryChip,
  Progress,
  Stat,
  Status,
  TxLink,
} from "../components/ui.tsx";
import { pullReason, same, short, usd, when, windowLabel } from "../format.ts";

export function PotPage() {
  const { id = "" } = useParams();
  const [search] = useSearchParams();
  const pot = usePot(id);
  const account = useCurrentAccount();

  if (pot.isLoading) return <p className="text-sm text-stone-500">Loading the pot…</p>;
  if (pot.error || !pot.data)
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">No such pot</h1>
        <Link className="text-brand-700 underline" to="/">
          Back to the pots
        </Link>
      </div>
    );

  const d = pot.data;
  const me = d.members.find((m) => same(m.address, account?.address));
  const created = search.get("created");

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <Link to="/" className="text-sm text-stone-500 hover:text-stone-800">
          ← All pots
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{d.pot.name}</h1>
          {d.pot.closed ? <Badge>closed</Badge> : <Badge tone="good">open</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Link
            className="font-medium text-brand-700 underline dark:text-brand-300"
            to={`/pots/${id}/learned`}
          >
            🧠 What Kitty learned
          </Link>
          <TxLink digest={d.pot.createDigest} label="created" />
        </div>
      </div>

      {created ? (
        <Card tone="brand">
          <p className="text-sm">
            Your pot is on Sui. <TxLink digest={created} /> Now join it below, and send the link to
            your friends.
          </p>
        </Card>
      ) : null}

      <Overview d={d} />
      <You d={d} me={me} />
      <Suggestion d={d} me={me} />
      <Members d={d} me={me} />
      <Proposals d={d} me={me} />
      <Pulls d={d} />
    </div>
  );
}

function Overview({ d }: { d: PotDetail }) {
  const goal = Number(d.pot.goal);
  const pct = goal > 0 ? (Number(d.totalIn) / goal) * 100 : 0;
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-2xl font-bold">
          {usd(d.totalIn)}{" "}
          <span className="text-base font-normal text-stone-500">of {usd(goal)}</span>
        </p>
        <p className="text-sm text-stone-500">by {when(d.pot.deadline)}</p>
      </div>
      <div className="mt-3">
        <Progress value={pct} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="In the pot now" value={d.onchain ? usd(d.onchain.balance) : "…"} />
        <Stat label="Spent" value={d.onchain ? usd(d.onchain.totalOut) : "…"} />
        <Stat label="Approvals to spend" value={d.pot.quorum} />
        <Stat label="Auto-ok up to" value={usd(d.onchain?.autoOkCap ?? d.pot.autoOkCap)} />
      </div>
    </Card>
  );
}

function You({ d, me }: { d: PotDetail; me: Member | undefined }) {
  const account = useCurrentAccount();
  const tx = useSponsored();
  const [name, setName] = useState("");
  const [cap, setCap] = useState("0.40");
  const [leaving, setLeaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  if (!account)
    return (
      <Card tone="muted">
        <p className="text-sm">
          Connect a wallet to join this pot, propose a spend or approve one.
        </p>
      </Card>
    );

  if (me?.active)
    return (
      <Card tone="brand">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">
            You're in as {me.name} {me.test ? <Badge tone="test">test</Badge> : null}
          </h2>
          <span className="text-sm text-stone-600 dark:text-stone-400">
            put in {usd(me.contributed)}
          </span>
        </div>
        <p className="mt-1 text-sm text-stone-700 dark:text-stone-300">
          {d.pot.closed
            ? "The pot is closed: what wasn't spent went back to the members pro rata, and Kitty pulls no more."
            : `Kitty may pull at most ${usd(me.capPerWindow)} per ${windowLabel(d.pot.windowMs)} from your USDC balance, until ${when(d.pot.deadline)}. Next pull: ${me.nextPullAt ? when(me.nextPullAt) : "when it's due"}.`}
        </p>
        {me.reason ? <MemoryChip memory={me.reason} label="Why:" /> : null}
        {d.pot.closed ? null : leaving ? (
          <div className="mt-3 space-y-2">
            <p className="text-sm">
              Leave? Your allowance is revoked, so Kitty can't pull from you again. What you put in
              stays in the pot and comes back pro rata when it closes.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="danger"
                disabled={tx.busy}
                onClick={async () => {
                  const r = await tx.run({ action: "leave", potId: d.pot.id });
                  if (r) {
                    setDone(r.digest);
                    setLeaving(false);
                  }
                }}
              >
                Leave the pot
              </Button>
              <Button variant="ghost" disabled={tx.busy} onClick={() => setLeaving(false)}>
                Stay
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3">
            <Button variant="ghost" onClick={() => setLeaving(true)}>
              Leave…
            </Button>
          </div>
        )}
        <div className="mt-2">
          <Status step={tx.step} error={tx.error} />
        </div>
        {done ? <Done digest={done} text="Done." /> : null}
      </Card>
    );

  if (me && !me.active)
    return (
      <Card tone="muted">
        <p className="text-sm">
          You left this pot. Kitty no longer pulls from you.{" "}
          {done ? <TxLink digest={done} label="left" /> : null}
        </p>
      </Card>
    );

  if (d.pot.closed)
    return (
      <Card tone="muted">
        <p className="text-sm">This pot is closed.</p>
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
    <Card tone="brand">
      <form onSubmit={join} className="space-y-3">
        <div>
          <h2 className="font-semibold">Join with one signature</h2>
          <p className="text-sm text-stone-700 dark:text-stone-300">
            You sign one allowance: Kitty's keeper may pull at most your cap per{" "}
            {windowLabel(d.pot.windowMs)} from your USDC balance, until {when(d.pot.deadline)}. Sui
            enforces the cap, not Kitty. You can leave any time. Gas is on Kitty.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
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
        <Status step={tx.step} error={tx.error} />
        <Button type="submit" disabled={tx.busy || !name.trim()}>
          Join with one signature
        </Button>
        {done ? <Done digest={done} text="You joined." /> : null}
      </form>
    </Card>
  );
}

function Done({ digest, text }: { digest: string; text: string }) {
  return (
    <p className="text-sm text-emerald-700 dark:text-emerald-300">
      {text} <TxLink digest={digest} />
    </p>
  );
}

function Suggestion({ d, me }: { d: PotDetail; me: Member | undefined }) {
  const tx = useSponsored();
  const s = d.suggestion;
  if (!s) return null;
  return (
    <Card tone="brand">
      <p className="text-sm">
        <span aria-hidden>🧠 </span>
        <strong>Kitty suggests:</strong> make {s.category} spends automatic up to {usd(s.cap)}. The
        group approved {s.n} of them, each within 10 minutes. Voting it in is a proposal like any
        other, and the contract enforces the result.
      </p>
      {s.memory ? <MemoryChip memory={s.memory} /> : null}
      {me?.active ? (
        <div className="mt-3 space-y-2">
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
          <Status step={tx.step} error={tx.error} />
        </div>
      ) : null}
    </Card>
  );
}

function Members({ d, me }: { d: PotDetail; me: Member | undefined }) {
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold">Members</h2>
      {d.members.length === 0 ? (
        <p className="text-sm text-stone-500">Nobody yet. Be the first to join.</p>
      ) : null}
      <div className="grid gap-2">
        {d.members.map((m) => (
          <Card key={m.address} className="!p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{m.name}</span>
                {m.test ? <Badge tone="test">test</Badge> : null}
                {same(m.address, me?.address) ? <Badge tone="brand">you</Badge> : null}
                {m.active ? null : <Badge>left</Badge>}
                <span className="font-mono text-xs text-stone-500">{short(m.address)}</span>
              </div>
              <span className="text-sm text-stone-600 dark:text-stone-400">
                put in <strong>{usd(m.contributed)}</strong>
              </span>
            </div>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
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
    </div>
  );
}

function describe(p: Proposal) {
  if (p.kind === "spend") return `${p.memo || "A spend"}: ${usd(p.amount)}`;
  if (p.kind === "auto_cap") return `Rule: spends up to ${usd(p.amount)} need no vote`;
  return "Close the pot and refund everyone pro rata";
}

function Proposals({ d, me }: { d: PotDetail; me: Member | undefined }) {
  const active = d.members.filter((m) => m.active);
  const needed = Math.min(d.pot.quorum, active.length);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Proposals</h2>
        <span className="text-xs text-stone-500">
          {needed} {needed === 1 ? "approval" : "approvals"} to pass
        </span>
      </div>
      {me?.active && !d.pot.closed ? <Propose d={d} /> : null}
      {d.proposals.length === 0 ? <p className="text-sm text-stone-500">None yet.</p> : null}
      <div className="grid gap-2">
        {d.proposals.map((p) => (
          <ProposalRow key={p.seq} d={d} p={p} me={me} needed={needed} />
        ))}
      </div>
    </div>
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
    <Card className="!p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">
            <span className="text-stone-400">#{p.seq}</span> {describe(p)}
          </p>
          {p.kind === "spend" && p.payee ? (
            <p className="text-xs text-stone-500">to {nameOf(p.payee)}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {p.executed ? (
            <Badge tone="good">done</Badge>
          ) : (
            <Badge tone="brand">
              {activeApprovals} of {needed}
            </Badge>
          )}
          {p.digest ? <TxLink digest={p.digest} /> : null}
        </div>
      </div>
      <p className="mt-1 text-xs text-stone-500">
        Approved by {p.approvals.map((a) => nameOf(a.member)).join(", ") || "nobody yet"}
      </p>
      {canApprove ? (
        <div className="mt-3 space-y-2">
          <Button
            disabled={tx.busy}
            onClick={() => tx.run({ action: "approve", potId: d.pot.id, seq: p.seq })}
          >
            {passes ? (p.kind === "spend" ? "Approve and pay" : "Approve and apply") : "Approve"}
          </Button>
          <Status step={tx.step} error={tx.error} />
        </div>
      ) : null}
    </Card>
  );
}

function Propose({ d }: { d: PotDetail }) {
  const tx = useSponsored();
  const [open, setOpen] = useState(false);
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
    if (r) {
      setOpen(false);
      setMemo("");
      setAmount("");
      setPayee("");
    }
  }

  if (!open)
    return (
      <div>
        <Button variant="ghost" onClick={() => setOpen(true)}>
          Propose a spend
        </Button>
      </div>
    );
  return (
    <Card>
      <form onSubmit={submit} className="space-y-3">
        <h3 className="font-semibold">Propose a spend</h3>
        <p className="text-sm text-stone-600 dark:text-stone-400">
          Your proposal counts as your approval. It pays out when {d.pot.quorum}{" "}
          {d.pot.quorum === 1 ? "member approves" : "members approve"}.
        </p>
        <Field
          label="What for"
          required
          maxLength={80}
          placeholder="hotel one night"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          hint="The first word is the kind (food, hotel, …): Kitty learns the group's habits by kind."
        />
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
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
        <Status step={tx.step} error={tx.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={tx.busy}>
            Propose it
          </Button>
          <Button variant="ghost" disabled={tx.busy} onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Pulls({ d }: { d: PotDetail }) {
  if (d.pulls.length === 0) return null;
  const nameOf = (a: string) => d.members.find((m) => same(m.address, a))?.name ?? short(a);
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold">Kitty's pulls</h2>
      <div className="grid gap-2">
        {d.pulls.map((p) => (
          <Card key={p.id} className="!p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge
                  tone={p.status === "sent" ? "good" : p.status === "skipped" ? "plain" : "bad"}
                >
                  {p.status}
                </Badge>
                <span className="text-sm font-medium">
                  {nameOf(p.member)} · {usd(p.amount)}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-stone-500">
                {when(p.createdAt)}
                {p.digest ? <TxLink digest={p.digest} /> : null}
              </div>
            </div>
            <p className="mt-1 text-sm break-words text-stone-600 dark:text-stone-400">
              {pullReason(p.status, p.reason)}
            </p>
            {p.memory ? <MemoryChip memory={p.memory} /> : null}
          </Card>
        ))}
      </div>
    </div>
  );
}

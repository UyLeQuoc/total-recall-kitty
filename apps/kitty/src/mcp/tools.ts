/**
 * Kitty's read tools for agents (KT4, ADR-0067): `pot_status`, `why` and `norms`. The stdio server
 * reads through Kitty's HTTP API; the remote `/mcp` endpoint reads in-process. Every memory line
 * carries its Walrus blob id, so an agent can cite what it read.
 */
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { str, type Tool } from "./protocol.ts";

/** `GET /api/pots/:id` as JSON (amounts are micro-dollar strings). */
export interface PotJson {
  pot: {
    id: string;
    name: string;
    goal: string;
    deadline: string;
    quorum: number;
    autoOkCap: string;
    closed: boolean;
  };
  onchain: { version: number; balance: string; totalIn: string; totalOut: string } | null;
  members: {
    address: string;
    name: string;
    test: boolean;
    active: boolean;
    contributed: string;
  }[];
  delegates: { member: string; agent: string; approveCap: string; setDigest: string }[];
  proposals: {
    seq: number;
    kind: string;
    payee: string | null;
    amount: string | null;
    memo: string | null;
    proposer: string;
    proposerAgent: string | null;
    approvals: { member: string; at: string; agent?: string; reason?: string }[];
    executed: boolean;
    digest: string | null;
  }[];
}

export interface MemoryJson {
  id: string;
  namespace: string;
  text: string;
  blobId: string | null;
  status: string;
  createdAt: string;
}

export interface Reads {
  pot(potId: string): Promise<PotJson | null>;
  /** Newest first. `q` searches, `about` keeps the lines about one member. */
  memories(
    potId: string,
    o: { ns?: "norms" | "members"; q?: string; about?: string },
  ): Promise<MemoryJson[]>;
}

export const usd = (micro: string | bigint | null | undefined) =>
  `$${(Number(micro ?? 0) / 1e6).toFixed(2)}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const potArg = (args: Record<string, unknown>, fixed?: string) => {
  const id = fixed ?? str(args.pot, "pot");
  if (fixed && args.pot && normalizeSuiAddress(String(args.pot)) !== normalizeSuiAddress(fixed))
    throw new Error("This token reads one pot only.");
  return normalizeSuiAddress(id);
};

export const memoryLine = (m: MemoryJson) =>
  `- [${m.blobId ? `blob ${m.blobId}` : `pending ${m.status}`}] ${m.text}`;

/** Who did what, in names: "Ava", "Bao's agent". */
export function approvalNames(p: PotJson["proposals"][number], members: PotJson["members"]) {
  const name = (a: string) => members.find((m) => m.address === a)?.name ?? short(a);
  return p.approvals.map((a) => (a.agent ? `${name(a.member)}'s agent` : name(a.member)));
}

export function potStatusText(d: PotJson, me?: string) {
  const active = d.members.filter((m) => m.active);
  const name = (a: string) => d.members.find((m) => m.address === a)?.name ?? short(a);
  const lines = [
    `Pot "${d.pot.name}" (${d.pot.id}), Sui testnet, version ${d.onchain?.version ?? "?"}${d.pot.closed ? ", CLOSED" : ""}.`,
    `Goal ${usd(d.pot.goal)} by ${d.pot.deadline.slice(0, 10)}. In the pot ${usd(d.onchain?.balance)} (put in ${usd(d.onchain?.totalIn)}, spent ${usd(d.onchain?.totalOut)}).`,
    `A spend needs ${Math.min(d.pot.quorum, active.length)} approvals (quorum ${d.pot.quorum}, ${active.length} active members). Auto-ok up to ${usd(d.pot.autoOkCap)}.`,
    "Members:",
    ...d.members.map((m) => {
      const del = d.delegates.find((x) => x.member === m.address);
      return `- ${m.name}${m.test ? " (test)" : ""} ${m.address}${m.active ? "" : " (left)"}, put in ${usd(m.contributed)}${del ? `; agent ${del.agent} approves for ${m.name} up to ${usd(del.approveCap)}` : ""}`;
    }),
  ];
  const mine = me ? d.delegates.filter((x) => x.agent === normalizeSuiAddress(me)) : [];
  if (me)
    lines.push(
      mine.length
        ? `You (agent ${normalizeSuiAddress(me)}) act for: ${mine.map((x) => `${name(x.member)} (member ${x.member}), up to ${usd(x.approveCap)} per spend`).join("; ")}. Rules, closing and anything above the cap are the member's.`
        : `You (agent ${normalizeSuiAddress(me)}) act for nobody in this pot.`,
    );
  const open = d.proposals.filter((p) => !p.executed);
  lines.push(open.length ? "Open proposals:" : "No open proposals.");
  for (const p of open) {
    const who = approvalNames(p, d.members);
    const what =
      p.kind === "spend"
        ? `"${p.memo}" ${usd(p.amount)} to ${p.payee}`
        : p.kind === "auto_cap"
          ? `rule: auto-ok up to ${usd(p.amount)}`
          : "close the pot";
    const caps = mine
      .filter((x) => p.kind === "spend" && !p.approvals.some((a) => a.member === x.member))
      .map(
        (x) =>
          `${BigInt(p.amount ?? 0) <= BigInt(x.approveCap) ? "within" : "ABOVE"} your cap for ${name(x.member)}`,
      );
    lines.push(
      `- #${p.seq} ${what}, proposed by ${p.proposerAgent ? `${name(p.proposer)}'s agent` : name(p.proposer)}; approvals: ${who.join(", ") || "none"}${caps.length ? `; ${caps.join("; ")}` : ""}`,
    );
  }
  const done = d.proposals.filter((p) => p.executed).slice(0, 5);
  if (done.length)
    lines.push(
      "Recently done:",
      ...done.map(
        (p) =>
          `- #${p.seq} "${p.memo ?? p.kind}" ${usd(p.amount)}, approved by ${approvalNames(p, d.members).join(", ")}`,
      ),
    );
  return lines.join("\n");
}

/** The read tools. `fixedPot` pins them to one pot (a remote token's pot). */
export function readTools(reads: Reads, o: { me?: string; fixedPot?: string } = {}): Tool[] {
  const potProp = o.fixedPot
    ? {}
    : { pot: { type: "string", description: "The pot's object id (0x…)." } };
  const required = o.fixedPot ? [] : ["pot"];
  return [
    {
      name: "pot_status",
      description:
        "The pot: its money, members, each member's agent and cap, and the open proposals. Read this before proposing or approving.",
      inputSchema: { type: "object", properties: { ...potProp }, required },
      readOnly: true,
      async run(args) {
        const id = potArg(args, o.fixedPot);
        const d = await reads.pot(id);
        if (!d) throw new Error(`No pot ${id}.`);
        return potStatusText(d, o.me);
      },
    },
    {
      name: "why",
      description:
        "Why Kitty did what it did for one member: paydays, skipped pulls, pulls and the member's agent, each with its Walrus memory blob.",
      inputSchema: {
        type: "object",
        properties: {
          ...potProp,
          member: { type: "string", description: "The member's name or address." },
        },
        required: [...required, "member"],
      },
      readOnly: true,
      async run(args) {
        const id = potArg(args, o.fixedPot);
        const d = await reads.pot(id);
        if (!d) throw new Error(`No pot ${id}.`);
        const want = str(args.member, "member").toLowerCase();
        const m = d.members.find(
          (x) => x.name.toLowerCase() === want || x.address === normalizeSuiAddress(want),
        );
        if (!m) throw new Error(`No member ${args.member} in this pot.`);
        const rows = await reads.memories(id, { about: m.address });
        return rows.length
          ? [`What Kitty remembers about ${m.name}:`, ...rows.slice(0, 12).map(memoryLine)].join(
              "\n",
            )
          : `Kitty has no memories about ${m.name} yet.`;
      },
    },
    {
      name: "norms",
      description:
        "What the group has agreed and how it behaves: agents and their caps, approvals, suggested and voted rules. Each line has its Walrus memory blob; cite the blob when you act on it.",
      inputSchema: {
        type: "object",
        properties: {
          ...potProp,
          query: { type: "string", description: "Optional: what to look for, e.g. food." },
        },
        required,
      },
      readOnly: true,
      async run(args) {
        const id = potArg(args, o.fixedPot);
        const q =
          typeof args.query === "string" && args.query.trim() ? args.query.trim() : undefined;
        const rows = await reads.memories(id, { ns: "norms", ...(q ? { q } : {}) });
        return rows.length
          ? ["The group's norms (newest first):", ...rows.slice(0, 15).map(memoryLine)].join("\n")
          : "No norms remembered for this pot yet.";
      },
    },
  ];
}

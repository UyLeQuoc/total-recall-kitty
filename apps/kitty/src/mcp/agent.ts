/**
 * The agent's side of Kitty's MCP (KT4, ADR-0067): the read tools over Kitty's HTTP API, plus
 * `propose_spend` and `approve`, signed with the agent's own key. Kitty's server builds each
 * transaction; this side signs it only after checking it:
 * - the agent is the sender;
 * - Kitty's sponsor pays the gas;
 * - every command is the expected `pot::*_as_delegate` call, on the pot and for the member it asked
 *   about, with the amount or proposal it asked for.
 */
import type { Keypair } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress, toHex } from "@mysten/sui/utils";
import { str, type Tool } from "./protocol.ts";
import { type MemoryJson, type PotJson, type Reads, readTools, usd } from "./tools.ts";

export interface AgentOptions {
  apiUrl: string;
  agent: Keypair;
  fetch?: typeof fetch;
}

interface Config {
  packageId: string;
  sponsor: string;
}

export class Refused extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly digest: string | null,
  ) {
    super(message);
  }
}

/** Reads through Kitty's HTTP API. */
export function httpReads(
  apiUrl: string,
  f: typeof fetch = fetch,
): Reads & {
  config(): Promise<Config>;
  post<T>(path: string, body: unknown): Promise<T>;
} {
  const get = async <T>(path: string): Promise<T> => {
    const res = await f(`${apiUrl}${path}`);
    const body = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) throw new Error(body.message ?? `Kitty answered ${res.status}.`);
    return body;
  };
  return {
    async pot(id) {
      return get<PotJson>(`/api/pots/${id}`).catch(() => null);
    },
    async memories(id, o) {
      const q = new URLSearchParams();
      if (o.ns) q.set("ns", o.ns);
      if (o.q) q.set("q", o.q);
      if (o.about) q.set("about", o.about);
      return get<MemoryJson[]>(`/api/pots/${id}/recall?${q}`);
    },
    config: () => get<Config>("/api/config"),
    async post<T>(path: string, body: unknown) {
      const res = await f(`${apiUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = (await res.json().catch(() => ({}))) as T & {
        message?: string;
        code?: string;
        digest?: string;
      };
      if (!res.ok)
        throw new Refused(
          out.message ?? `Kitty answered ${res.status}.`,
          out.code ?? null,
          out.digest ?? null,
        );
      return out;
    },
  };
}

/** What a prepared transaction must be before the agent signs it. */
export interface Expected {
  agent: string;
  sponsor: string;
  packageId: string;
  potId: string;
  member: string;
  functions: string[];
  /** `propose_as_delegate`'s amount, or the proposal number for the approval calls. */
  amount?: bigint;
  seq?: number;
}

const u64le = (b: Uint8Array) => {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i] as number);
  return v;
};

/** Throws unless `bytes` is exactly the delegate call the agent asked for. */
export function checkPrepared(bytes: string, e: Expected) {
  const data = Transaction.from(bytes).getData();
  const same = (a: string | null | undefined, b: string) =>
    !!a && normalizeSuiAddress(a) === normalizeSuiAddress(b);
  if (!same(data.sender, e.agent)) throw new Error("Refusing to sign: the agent isn't the sender.");
  if (!same(data.gasData.owner, e.sponsor))
    throw new Error("Refusing to sign: Kitty's sponsor doesn't pay the gas.");
  if (!data.commands.length) throw new Error("Refusing to sign: an empty transaction.");
  const input = (arg: unknown) => {
    const i = (arg as { Input?: number })?.Input;
    return typeof i === "number" ? data.inputs[i] : undefined;
  };
  const pure = (arg: unknown) => {
    const b = (input(arg) as { Pure?: { bytes: string } } | undefined)?.Pure?.bytes;
    if (!b) throw new Error("Refusing to sign: an argument isn't a plain value.");
    return fromBase64(b);
  };
  for (const c of data.commands) {
    const call = (
      c as {
        MoveCall?: { package: string; module: string; function: string; arguments: unknown[] };
      }
    ).MoveCall;
    if (!call) throw new Error("Refusing to sign: a command isn't a Move call.");
    if (
      !same(call.package, e.packageId) ||
      call.module !== "pot" ||
      !e.functions.includes(call.function)
    )
      throw new Error(`Refusing to sign: unexpected call ${call.module}::${call.function}.`);
    const obj =
      (input(call.arguments[0]) as {
        Object?: { SharedObject?: { objectId: string } };
        UnresolvedObject?: { objectId: string };
      }) ?? {};
    const potId = obj.Object?.SharedObject?.objectId ?? obj.UnresolvedObject?.objectId;
    if (!same(potId, e.potId)) throw new Error("Refusing to sign: a call is on another pot.");
    if (!same(`0x${toHex(pure(call.arguments[1]))}`, e.member))
      throw new Error("Refusing to sign: a call is for another member.");
    if (call.function === "propose_as_delegate" && e.amount !== undefined) {
      if (u64le(pure(call.arguments[3])) !== e.amount)
        throw new Error("Refusing to sign: the amount isn't the one asked for.");
    }
    if (call.function !== "propose_as_delegate" && e.seq !== undefined) {
      if (u64le(pure(call.arguments[2])) !== BigInt(e.seq))
        throw new Error("Refusing to sign: another proposal.");
    }
  }
}

const micro = (dollars: number) => BigInt(Math.round(dollars * 1e6));

/** The agent's tools: the read tools, `propose_spend` and `approve`. */
export function agentTools(o: AgentOptions): Tool[] {
  const api = httpReads(o.apiUrl, o.fetch);
  const me = normalizeSuiAddress(o.agent.toSuiAddress());
  let config: Config | null = null;

  async function memberAddress(potId: string, who: string) {
    const d = await api.pot(potId);
    if (!d) throw new Error(`No pot ${potId}.`);
    const want = who.toLowerCase();
    const m = d.members.find(
      (x) => x.name.toLowerCase() === want || x.address === normalizeSuiAddress(want),
    );
    if (!m) throw new Error(`No member ${who} in this pot.`);
    return m;
  }

  /** Prepare on the server, check, sign with the agent's key, execute. */
  async function act(
    body: Record<string, unknown>,
    e: Omit<Expected, "agent" | "sponsor" | "packageId">,
  ) {
    config ??= await api.config();
    const prepared = await api.post<{ bytes: string; digest: string }>("/api/tx/prepare", {
      ...body,
      sender: me,
    });
    checkPrepared(prepared.bytes, {
      ...e,
      agent: me,
      sponsor: config.sponsor,
      packageId: config.packageId,
    });
    const { signature } = await o.agent.signTransaction(fromBase64(prepared.bytes));
    return api.post<Record<string, unknown>>("/api/tx/execute", {
      digest: prepared.digest,
      signature,
      bytes: prepared.bytes,
    });
  }

  const potProp = { pot: { type: "string", description: "The pot's object id (0x…)." } };
  return [
    ...readTools(api, { me }),
    {
      name: "propose_spend",
      description:
        "Propose a spend from the pot for the member you act for. Within your cap it carries that member's approval; above it, it waits for the member. Give a one-line reason (a quote helps).",
      inputSchema: {
        type: "object",
        properties: {
          ...potProp,
          member: { type: "string", description: "The member you act for (name or address)." },
          payee: { type: "string", description: "Who gets paid (Sui address)." },
          amount_usd: { type: "number", description: "In dollars, e.g. 0.05." },
          memo: { type: "string", description: "What for, e.g. food: snacks." },
          reason: { type: "string", description: "One line: why, citing a memory blob if any." },
        },
        required: ["pot", "member", "payee", "amount_usd", "memo", "reason"],
      },
      readOnly: false,
      async run(args) {
        const potId = normalizeSuiAddress(str(args.pot, "pot"));
        const m = await memberAddress(potId, str(args.member, "member"));
        const amount = Number(args.amount_usd);
        if (!(amount > 0)) throw new Error("amount_usd must be more than zero.");
        const out = await act(
          {
            action: "agent_propose",
            potId,
            member: m.address,
            payee: str(args.payee, "payee"),
            amountUsd: amount,
            memo: str(args.memo, "memo").slice(0, 80),
            reason: str(args.reason, "reason").slice(0, 240),
          },
          { potId, member: m.address, functions: ["propose_as_delegate"], amount: micro(amount) },
        ).catch(refusal);
        return typeof out === "string"
          ? out
          : `Proposed #${out.seq} for ${m.name}: ${usd(String(micro(amount)))} "${args.memo}". ${out.withinCap ? `It carries ${m.name}'s approval (within your cap).` : `It's above your cap, so it waits for ${m.name}.`} Digest ${out.digest}.`;
      },
    },
    {
      name: "approve",
      description:
        "Approve a proposed spend for the member you act for, up to your cap. When your approval reaches the quorum, the spend is paid in the same transaction. Above your cap the chain refuses, and the member decides. Give a one-line reason citing the memory blob you relied on.",
      inputSchema: {
        type: "object",
        properties: {
          ...potProp,
          member: { type: "string", description: "The member you act for (name or address)." },
          seq: { type: "number", description: "The proposal number (#)." },
          reason: { type: "string", description: "One line: why, citing a memory blob." },
          record_refusal: {
            type: "boolean",
            description:
              "Send it even if the chain would refuse, so the refusal is recorded onchain with a digest. Off by default.",
          },
        },
        required: ["pot", "member", "seq", "reason"],
      },
      readOnly: false,
      async run(args) {
        const potId = normalizeSuiAddress(str(args.pot, "pot"));
        const m = await memberAddress(potId, str(args.member, "member"));
        const seq = Number(args.seq);
        if (!Number.isInteger(seq) || seq < 0) throw new Error("seq is a proposal number.");
        const out = await act(
          {
            action: "agent_approve",
            potId,
            member: m.address,
            seq,
            reason: str(args.reason, "reason").slice(0, 240),
            recordRefusal: args.record_refusal === true,
          },
          {
            potId,
            member: m.address,
            functions: ["approve_as_delegate", "execute_as_delegate"],
            seq,
          },
        ).catch(refusal);
        return typeof out === "string"
          ? out
          : `Approved #${seq} for ${m.name}${out.executed ? ", which reached the quorum and was paid" : ""}. Digest ${out.digest}.`;
      },
    },
  ];
}

function refusal(err: unknown): string {
  if (err instanceof Refused)
    return `Refused: ${err.message}${err.code ? ` (${err.code})` : ""}${err.digest ? `. Recorded onchain: ${err.digest}` : ". Nothing was sent"}.`;
  throw err;
}

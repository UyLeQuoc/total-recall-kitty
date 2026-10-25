#!/usr/bin/env bun
/**
 * The treasurer, Kitty's reference agent (KT4, ADR-0067). It acts for one member through Kitty's stdio
 * MCP server, which holds the agent's key, and decides with an OpenRouter model (`LLM_MODEL`). Every
 * decision is the model's own output, and its reason must cite a memory blob it read.
 *
 *   bun --env-file=../../.env agents/treasurer/index.ts review  --pot 0x… --member Bao [--seq 3] \
 *       [--ask "Bao: please approve the hotel"]   # the member's own request, a message from them
 *   bun --env-file=../../.env agents/treasurer/index.ts propose --pot 0x… --member Bao \
 *       --payee 0x… --amount 0.05 --memo "food: snacks" --quote "Bánh mì stall, 2 × $0.025"
 *   bun --env-file=../../.env agents/treasurer/index.ts approve --pot 0x… --member Bao --seq 3 \
 *       --reason "…" --record-refusal     # a FORCED attempt, no model: shows the chain refusing
 *
 * It prints one JSON line per decision on stdout.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { approveArgs, blobsIn, type ChatMessage, reviewMessages, systemPrompt } from "./prompt.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.LLM_MODEL || "google/gemini-2.5-flash";

function flags(argv: string[]) {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

/** A minimal MCP client over the stdio server's newline-delimited JSON-RPC. */
class Mcp {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private next = 1;
  private waiting = new Map<number, (v: unknown) => void>();

  constructor() {
    this.proc = spawn("bun", [join(here, "../../src/mcp/stdio.ts")], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stderr.on("data", (d) => process.stderr.write(d));
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf("\n");
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        nl = this.buffer.indexOf("\n");
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id: number };
        this.waiting.get(msg.id)?.(msg);
        this.waiting.delete(msg.id);
      }
    });
  }

  private request(method: string, params: Record<string, unknown> = {}) {
    const id = this.next++;
    return new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>((r) => {
      this.waiting.set(id, r as (v: unknown) => void);
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async init() {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "kitty-treasurer", version: "0.1.0" },
    });
    this.proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  }

  async tool(name: string, args: Record<string, unknown>) {
    const out = await this.request("tools/call", { name, arguments: args });
    if (out.error) throw new Error(out.error.message);
    const r = out.result as { content: { text: string }[]; isError?: boolean };
    const text = r.content.map((c) => c.text).join("\n");
    if (r.isError) throw new Error(text);
    return text;
  }

  close() {
    this.proc.kill();
  }
}

interface Decision {
  decision: "approve" | "decline" | "propose";
  reason: string;
  cite: string;
}

/** Asks the model for a decision as JSON; the cited blob must be one it was shown. */
async function decide(messages: ChatMessage[], blobs: Set<string>): Promise<Decision> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set.");
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: attempt
          ? [
              ...messages,
              {
                role: "user",
                content: `Your last answer cited a blob that isn't listed: ${last}. Cite one of the listed blobs.`,
              },
            ]
          : messages,
      }),
    });
    if (!res.ok)
      throw new Error(`OpenRouter answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    const raw = body.choices[0]?.message.content ?? "{}";
    const json = JSON.parse(
      raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1),
    ) as Partial<Decision>;
    const cite = String(json.cite ?? "")
      .replace(/^blob\s+/i, "")
      .trim();
    last = cite;
    if (blobs.has(cite) && json.decision && json.reason)
      return { decision: json.decision, reason: String(json.reason).slice(0, 200), cite };
  }
  throw new Error(`The model didn't cite a memory it was shown (last: ${last || "none"}).`);
}

async function review(mcp: Mcp, f: Record<string, string | true>) {
  const pot = String(f.pot);
  const member = String(f.member);
  const status = await mcp.tool("pot_status", { pot });
  const norms = await mcp.tool("norms", { pot });
  const blobs = blobsIn(norms);
  const open = [...status.matchAll(/^- #(\d+) "([^"]*)" \$([\d.]+)[^\n]*$/gm)]
    .map((m) => ({ seq: Number(m[1]), line: m[0] }))
    .filter((p) => (typeof f.seq === "string" ? p.seq === Number(f.seq) : true))
    .filter((p) => /your cap for/.test(p.line));
  if (!open.length) {
    console.log(JSON.stringify({ member, pot, note: "nothing open for this agent to review" }));
    return;
  }
  for (const p of open) {
    const ask = typeof f.ask === "string" ? f.ask : undefined;
    const d = await decide(
      reviewMessages({ member, seq: p.seq, status, norms, ...(ask ? { ask } : {}) }),
      blobs,
    );
    const result =
      d.decision === "approve"
        ? await mcp.tool(
            "approve",
            approveArgs({
              pot,
              member,
              seq: p.seq,
              reason: d.reason,
              cite: d.cite,
              ...(ask ? { ask } : {}),
            }),
          )
        : "Declined: left for the member.";
    console.log(
      JSON.stringify({
        agent: "treasurer",
        model: MODEL,
        pot,
        member,
        seq: p.seq,
        ...(ask ? { ask } : {}),
        ...d,
        result,
      }),
    );
  }
}

async function propose(mcp: Mcp, f: Record<string, string | true>) {
  const pot = String(f.pot);
  const member = String(f.member);
  const status = await mcp.tool("pot_status", { pot });
  const norms = await mcp.tool("norms", { pot });
  const blobs = blobsIn(norms);
  const ask = `Should you propose this spend for ${member}? memo "${f.memo}", amount $${f.amount}, payee ${f.payee}, quote: ${f.quote ?? "none"}. Answer decision "propose" or "decline".`;
  const d = await decide(
    [
      { role: "system", content: systemPrompt(member) },
      { role: "user", content: `${ask}\n\nDATA\n\n${status}\n\n${norms}` },
    ],
    blobs,
  );
  const result =
    d.decision === "propose"
      ? await mcp.tool("propose_spend", {
          pot,
          member,
          payee: String(f.payee),
          amount_usd: Number(f.amount),
          memo: String(f.memo),
          reason: `${d.reason}${f.quote ? ` Quote: ${f.quote}.` : ""} (memory ${d.cite})`,
        })
      : "Declined: not proposed.";
  console.log(JSON.stringify({ agent: "treasurer", model: MODEL, pot, member, ...d, result }));
}

/** A forced attempt, without the model: only to show what the chain does. Labelled as forced. */
async function forced(mcp: Mcp, f: Record<string, string | true>) {
  const result = await mcp.tool("approve", {
    pot: String(f.pot),
    member: String(f.member),
    seq: Number(f.seq),
    reason: `FORCED (no model): ${String(f.reason ?? "testing the cap")}`,
    record_refusal: f["record-refusal"] === true,
  });
  console.log(JSON.stringify({ agent: "treasurer", forced: true, seq: Number(f.seq), result }));
}

const [command, ...rest] = process.argv.slice(2);
const f = flags(rest);
if (!command || !f.pot || !f.member) {
  process.stderr.write("usage: index.ts review|propose|approve --pot 0x… --member <name> …\n");
  process.exit(2);
}
const mcp = new Mcp();
try {
  await mcp.init();
  if (command === "review") await review(mcp, f);
  else if (command === "propose") await propose(mcp, f);
  else if (command === "approve") await forced(mcp, f);
  else throw new Error(`unknown command ${command}`);
} catch (err) {
  console.log(JSON.stringify({ agent: "treasurer", error: (err as Error).message }));
  process.exitCode = 1;
} finally {
  mcp.close();
}

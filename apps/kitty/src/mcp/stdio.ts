#!/usr/bin/env bun
/**
 * Kitty's MCP server on stdio, on the agent's side (KT4, ADR-0067). It holds the agent's own key; Kitty's
 * server never sees it.
 *   claude mcp add kitty -e KITTY_AGENT_KEY=<the agent's key> -e KITTY_API_URL=http://localhost:8821 \
 *     -- bun <repo>/apps/kitty/src/mcp/stdio.ts
 * Nothing but the protocol goes to stdout; the key is never printed.
 */
import { keypairFrom } from "../keys.ts";
import { agentTools } from "./agent.ts";
import { createMcpHandler, type Rpc } from "./protocol.ts";

const raw = process.env.KITTY_AGENT_KEY;
if (!raw) {
  process.stderr.write("KITTY_AGENT_KEY is not set: the agent's own key (suiprivkey…).\n");
  process.exit(1);
}
const agent = keypairFrom(raw, "KITTY_AGENT_KEY");
const handle = createMcpHandler({
  name: "kitty",
  instructions:
    "Kitty is a group pot on Sui testnet. You act for one member, inside a cap the chain enforces. Read pot_status and norms first; cite the memory blob you rely on in every reason.",
  tools: agentTools({ apiUrl: process.env.KITTY_API_URL ?? "http://localhost:8821", agent }),
});

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let nl = buffer.indexOf("\n");
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf("\n");
    if (!line) continue;
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      continue;
    }
    void handle(msg).then((out) => {
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    });
  }
});

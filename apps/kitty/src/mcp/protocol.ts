/**
 * MCP over JSON-RPC 2.0 (KT4, ADR-0067), small enough to speak without an SDK, like Remora's
 * `packages/mcp`. One handler serves the stdio server (the agent's side, with its key) and the remote
 * Streamable HTTP endpoint (`/mcp`, read tools only).
 */

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface Rpc {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Read tools are the only ones the remote endpoint offers. */
  readOnly: boolean;
  run(args: Record<string, unknown>): Promise<string>;
}

export function createMcpHandler(o: { name: string; instructions: string; tools: Tool[] }) {
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  /** One JSON-RPC message in, at most one out (notifications get no answer). */
  return async function handle(msg: Rpc): Promise<Record<string, unknown> | null> {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
    const fail = (code: number, message: string) => ({
      jsonrpc: "2.0",
      id: msg.id ?? null,
      error: { code, message },
    });
    if (msg.id === undefined || msg.id === null) return null;
    switch (msg.method) {
      case "initialize": {
        const asked = String(msg.params?.protocolVersion ?? "");
        return reply({
          protocolVersion: (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
            ? asked
            : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: o.name, version: "0.2.0" },
          instructions: o.instructions,
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: o.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: t.readOnly },
          })),
        });
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const tool = byName.get(name);
        if (!tool) return fail(-32602, `Unknown tool ${name}.`);
        try {
          const text = await tool.run((msg.params?.arguments as Record<string, unknown>) ?? {});
          return reply({ content: [{ type: "text", text }] });
        } catch (err) {
          return reply({
            content: [{ type: "text", text: (err as Error).message }],
            isError: true,
          });
        }
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  };
}

export const str = (v: unknown, name: string): string => {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  if (!s) throw new Error(`${name} is required.`);
  return s;
};

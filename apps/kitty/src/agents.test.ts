/**
 * Agents, without a network (KT4, ADR-0067): the agent's MCP server refuses to sign anything but the
 * delegate call it asked for, and the MCP protocol and status text read right.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import { describe, expect, it } from "vitest";
import { checkPrepared, type Expected } from "./mcp/agent.ts";
import { createMcpHandler } from "./mcp/protocol.ts";
import { type PotJson, potStatusText, readTools } from "./mcp/tools.ts";

const PKG = normalizeSuiAddress("0xabc");
const POT = normalizeSuiAddress("0x9001");
const agent = Ed25519Keypair.generate().toSuiAddress();
const sponsor = Ed25519Keypair.generate().toSuiAddress();
const bao = Ed25519Keypair.generate().toSuiAddress();
const ava = Ed25519Keypair.generate().toSuiAddress();
const USDC = "0x2::sui::SUI";

/** What Kitty's server builds for `agent_approve`, fully resolved so no client is needed. */
async function prepared(
  o: {
    sender?: string;
    gasOwner?: string;
    fn?: string;
    pkg?: string;
    pot?: string;
    member?: string;
    seq?: number;
    extra?: (tx: Transaction) => void;
  } = {},
) {
  const tx = new Transaction();
  tx.setSender(o.sender ?? agent);
  tx.setGasOwner(o.gasOwner ?? sponsor);
  tx.setGasBudget(10_000_000);
  tx.setGasPrice(1000);
  tx.setGasPayment([
    {
      objectId: normalizeSuiAddress("0x77"),
      version: "1",
      digest: "4f5hU1tJCdW6RWhsrR8u2Ug4o2YsAqjGWkGh2zqPWbs7",
    },
  ]);
  const args = () => [
    tx.sharedObjectRef({
      objectId: o.pot ?? POT,
      initialSharedVersion: 7,
      mutable: true,
    }),
    tx.pure.address(o.member ?? bao),
    tx.pure.u64(o.seq ?? 3),
  ];
  tx.moveCall({
    target: `${o.pkg ?? PKG}::pot::${o.fn ?? "approve_as_delegate"}`,
    typeArguments: [USDC],
    arguments: args(),
  });
  o.extra?.(tx);
  return toBase64(await tx.build());
}

const expected: Expected = {
  agent,
  sponsor,
  packageId: PKG,
  potId: POT,
  member: bao,
  functions: ["approve_as_delegate", "execute_as_delegate"],
  seq: 3,
};

describe("the agent's MCP server signs only the call it asked for", () => {
  it("accepts the delegate approval it asked for, and nothing that isn't a transaction", async () => {
    const ok = await prepared();
    expect(() => checkPrepared(ok, expected)).not.toThrow();
    expect(() => checkPrepared("", expected)).toThrow();
    expect(() => checkPrepared("not a transaction", expected)).toThrow();
  });

  it.each([
    ["another sender", { sender: ava }, "isn't the sender"],
    ["another gas owner", { gasOwner: ava }, "sponsor doesn't pay"],
    ["the member's own approve", { fn: "approve" }, "unexpected call"],
    ["another package", { pkg: "0xdef" }, "unexpected call"],
    ["another pot", { pot: "0x9002" }, "another pot"],
    ["another member", { member: ava }, "another member"],
    ["another proposal", { seq: 4 }, "another proposal"],
  ])("refuses %s", async (_name, o, msg) => {
    const bytes = await prepared(o);
    expect(() => checkPrepared(bytes, expected)).toThrow(msg);
  });

  it("refuses a smuggled extra command", async () => {
    const bytes = await prepared({
      extra: (tx) => {
        const [coin] = tx.splitCoins(tx.gas, [1]);
        tx.transferObjects([coin], ava);
      },
    });
    expect(() => checkPrepared(bytes, expected)).toThrow("isn't a Move call");
  });
});

const pot: PotJson = {
  pot: {
    id: POT,
    name: "Da Lat trip (test)",
    goal: "1500000",
    deadline: "2026-11-08T09:00:00.000Z",
    quorum: 2,
    autoOkCap: "0",
    closed: false,
  },
  onchain: { version: 2, balance: "250000", totalIn: "300000", totalOut: "50000" },
  members: [
    {
      address: normalizeSuiAddress(ava),
      name: "Ava",
      test: true,
      active: true,
      contributed: "150000",
    },
    {
      address: normalizeSuiAddress(bao),
      name: "Bao",
      test: true,
      active: true,
      contributed: "150000",
    },
  ],
  delegates: [
    {
      member: normalizeSuiAddress(bao),
      agent: normalizeSuiAddress(agent),
      approveCap: "100000",
      setDigest: "d",
    },
  ],
  proposals: [
    {
      seq: 2,
      kind: "spend",
      payee: normalizeSuiAddress(ava),
      amount: "200000",
      memo: "hotel deposit",
      proposer: normalizeSuiAddress(ava),
      proposerAgent: null,
      approvals: [{ member: normalizeSuiAddress(ava), at: "t" }],
      executed: false,
      digest: "d",
    },
    {
      seq: 1,
      kind: "spend",
      payee: normalizeSuiAddress(ava),
      amount: "50000",
      memo: "food snacks",
      proposer: normalizeSuiAddress(ava),
      proposerAgent: null,
      approvals: [
        { member: normalizeSuiAddress(ava), at: "t" },
        {
          member: normalizeSuiAddress(bao),
          at: "t",
          agent: normalizeSuiAddress(agent),
          reason: "ok",
        },
      ],
      executed: true,
      digest: "d",
    },
  ],
};

describe("what an agent reads", () => {
  it("states its mandate and which proposals are above its cap", () => {
    const t = potStatusText(pot, agent);
    expect(t).toContain("act for: Bao");
    expect(t).toContain("up to $0.10 per spend");
    expect(t).toContain('#2 "hotel deposit" $0.20');
    expect(t).toContain("ABOVE your cap for Bao");
    expect(t).toContain("approved by Ava, Bao's agent");
  });

  it("speaks MCP: initialize, a read-only tool list, errors as tool results", async () => {
    const handle = createMcpHandler({
      name: "kitty",
      instructions: "test",
      tools: readTools({ pot: async () => pot, memories: async () => [] }, { fixedPot: POT }),
    });
    const init = (await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    })) as {
      result: { protocolVersion: string };
    };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
      result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual(["pot_status", "why", "norms"]);
    expect(list.result.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    const other = (await handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "pot_status", arguments: { pot: "0x1234" } },
    })) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(other.result.isError).toBe(true);
    expect(other.result.content[0]?.text).toContain("one pot only");
    const none = (await handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "norms", arguments: {} },
    })) as { result: { content: { text: string }[] } };
    expect(none.result.content[0]?.text).toContain("No norms");
  });
});

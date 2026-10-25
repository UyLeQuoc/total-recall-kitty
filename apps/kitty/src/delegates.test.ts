/**
 * Delegates, agent actions and the remote MCP tokens against the local dev database (KT4, ADR-0067),
 * with a fake chain and a fake memory. CI has no Postgres, so these skip themselves there.
 */
import { randomUUID } from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ActionDeps,
  ActionError,
  agentApprove,
  propose,
  revokeDelegate,
  setDelegate,
} from "./actions.ts";
import { createApp, potDetail } from "./app.ts";
import { type KittyChain, micro } from "./chain.ts";
import {
  createDb,
  delegates,
  mcpTokens,
  members,
  memories,
  pots,
  proposals,
  spends,
} from "./db/index.ts";
import { revokeMessage, tokenMessage } from "./mcp/messages.ts";
import type { KittyMemory } from "./memory.ts";

const db = createDb(process.env.DATABASE_URL ?? "postgres://kitty:kitty@localhost:5436/kitty");
let up = false;
const tag = randomUUID().slice(0, 8);
const potId = normalizeSuiAddress(`0x7e57${tag}`);
const [ava, bao, agent] = [
  Ed25519Keypair.generate(),
  Ed25519Keypair.generate(),
  Ed25519Keypair.generate(),
];
const A = normalizeSuiAddress(ava.toSuiAddress());
const B = normalizeSuiAddress(bao.toSuiAddress());
const AGENT = normalizeSuiAddress(agent.toSuiAddress());

const sent: string[] = [];
const chain = {
  packageId: "0x1",
  typeOrigin: "0x1",
  coinType: "0x2::usdc::USDC",
  sponsor: "0x5",
  client: {
    core: {
      async getObject() {
        throw new Error("offline");
      },
    },
  } as never,
  async run(signer) {
    const digest = `digest-${tag}-${sent.length + 1}-${signer.toSuiAddress().slice(2, 6)}`;
    sent.push(digest);
    return { digest, success: true, error: null, created: [], events: [] };
  },
  async usdcAddressBalance() {
    return 0n;
  },
} satisfies KittyChain;
const memory: KittyMemory = {
  async remember(namespace, kind, text) {
    const id = randomUUID();
    await db.insert(memories).values({
      id,
      namespace,
      kind,
      text,
      sha256: id,
      status: "stored",
      blobId: `blob-${id.slice(0, 8)}`,
    });
    return { id, saved: true };
  },
  async recall() {
    return [];
  },
  async flush() {},
};
const deps: ActionDeps = {
  db,
  chain,
  memory,
  keys: new Map([
    [A, ava],
    [B, bao],
  ]),
};
const app = createApp({ ...deps, keeper: "0x6" });

beforeAll(async () => {
  up = await Promise.race([
    db.execute("select 1 from kitty.delegates limit 1").then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
  ]).catch(() => false);
  if (!up) return;
  await db.insert(pots).values({
    id: potId,
    name: "delegates unit test",
    goal: micro(1),
    deadline: new Date(Date.now() + 3 * 3600_000),
    keeper: "0x6",
    quorum: 2,
    autoOkCap: 0n,
    windowMs: 3600_000,
    coinType: chain.coinType,
    createDigest: "d",
  });
  const m = (address: string, name: string) => ({
    potId,
    address,
    name,
    test: true,
    capPerWindow: micro(0.4),
    allowanceId: "0xa",
    allowanceCapId: "0xb",
    allowanceName: "kitty:test",
    joinDigest: "d",
  });
  await db.insert(members).values([m(A, "Ava"), m(B, "Bao")]);
});

afterAll(async () => {
  if (!up) return;
  for (const t of [proposals, spends, delegates, mcpTokens, members] as const)
    await db.delete(t).where(eq(t.potId, potId));
  await db.delete(pots).where(eq(pots.id, potId));
  for (const ns of [`kitty:pot:${potId}:members`, `kitty:pot:${potId}:norms`])
    await db.delete(memories).where(eq(memories.namespace, ns));
});

describe("an agent with a mandate", () => {
  it("is named by its member, remembered, and shown on the pot", async (ctx) => {
    if (!up) return ctx.skip();
    const d = await setDelegate(deps, { potId, member: B, agent: AGENT, approveCap: micro(0.1) });
    expect(d.memoryId).toBeTruthy();
    const [row] = await db.select().from(delegates).where(eq(delegates.potId, potId));
    expect(row?.active).toBe(true);
    const [m] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, d.memoryId as string));
    expect(m?.text).toContain(`DELEGATE member=${B} (Bao) named agent=${AGENT}`);
    const detail = await potDetail(deps, potId);
    expect(detail?.delegates[0]?.agent).toBe(AGENT);
    expect(detail?.delegates[0]?.reason?.blobId).toMatch(/^blob-/);
  });

  it("can't act through Kitty's server without its own key", async (ctx) => {
    if (!up) return ctx.skip();
    await propose(deps, potId, A, { kind: "spend", payee: A, amount: micro(0.05), memo: "food" });
    await expect(
      agentApprove(deps, { potId, member: B, agent: AGENT, seq: 0, reason: "within cap" }),
    ).rejects.toBeInstanceOf(ActionError);
  });

  it("approves with its own key, labelled as the agent's; at quorum the spend is paid", async (ctx) => {
    if (!up) return ctx.skip();
    const out = await agentApprove(
      { ...deps, signer: agent },
      { potId, member: B, agent: AGENT, seq: 0, reason: "food $0.05 is within Bao's cap (blob x)" },
    );
    expect(out.executed).toBe(true);
    const [p] = await db.select().from(proposals).where(eq(proposals.potId, potId));
    expect(p?.executed).toBe(true);
    expect(p?.approvals.at(-1)).toMatchObject({ member: B, agent: AGENT });
    const paid = await db.select().from(spends).where(eq(spends.potId, potId));
    expect(paid).toHaveLength(1);
    const notes = await db
      .select()
      .from(memories)
      .where(eq(memories.namespace, `kitty:pot:${potId}:norms`));
    expect(notes.some((n) => n.text.startsWith("AGENT_APPROVED proposal=0"))).toBe(true);
  });

  it("is revoked by its member", async (ctx) => {
    if (!up) return ctx.skip();
    await revokeDelegate(deps, potId, B);
    const rows = await db.select().from(delegates).where(eq(delegates.potId, potId));
    expect(rows.every((r) => !r.active)).toBe(true);
    await expect(revokeDelegate(deps, potId, B)).rejects.toBeInstanceOf(ActionError);
  });
});

describe("read-only remote MCP", () => {
  const call = (token: string | null, body: unknown) =>
    app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it("gives a member a token once, lists it without the secret, and serves only read tools", async (ctx) => {
    if (!up) return ctx.skip();
    const at = new Date().toISOString();
    const { signature } = await bao.signPersonalMessage(
      new TextEncoder().encode(tokenMessage({ potId, member: B, name: "claude", at })),
    );
    const res = await app.request(`/api/pots/${potId}/mcp-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ member: B, name: "claude", at, signature }),
    });
    expect(res.status).toBe(201);
    const { id, token } = (await res.json()) as { id: string; token: string };
    expect(token).toMatch(/^kitty_/);
    const listed = await (await app.request(`/api/pots/${potId}/mcp-tokens`)).text();
    expect(listed).not.toContain(token);
    expect(listed).not.toContain("sha256");

    expect((await call(null, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    const list = (await (
      await call(token, { jsonrpc: "2.0", id: 1, method: "tools/list" })
    ).json()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["pot_status", "why", "norms"]);
    const status = (await (
      await call(token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "pot_status", arguments: {} },
      })
    ).json()) as { result: { content: { text: string }[] } };
    expect(status.result.content[0]?.text).toContain("delegates unit test");
    expect(
      (await call(token, { jsonrpc: "2.0", method: "notifications/initialized" })).status,
    ).toBe(202);

    const rat = new Date().toISOString();
    const forged = await ava.signPersonalMessage(
      new TextEncoder().encode(revokeMessage({ potId, tokenId: id, member: B, at: rat })),
    );
    const bad = await app.request(`/api/pots/${potId}/mcp-tokens/${id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ member: B, at: rat, signature: forged.signature }),
    });
    expect(bad.status).toBe(401);
    const real = await bao.signPersonalMessage(
      new TextEncoder().encode(revokeMessage({ potId, tokenId: id, member: B, at: rat })),
    );
    const ok = await app.request(`/api/pots/${potId}/mcp-tokens/${id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ member: B, at: rat, signature: real.signature }),
    });
    expect(ok.status).toBe(200);
    expect((await call(token, { jsonrpc: "2.0", id: 3, method: "tools/list" })).status).toBe(401);
  });
});

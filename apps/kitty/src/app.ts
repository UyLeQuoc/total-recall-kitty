/**
 * Kitty's API (KT3, ADR-0062 and ADR-0064). The web in `web/` is the main surface: members sign with
 * their own wallet, through `/api/tx/prepare` and `/api/tx/execute`, and the sponsor pays the gas. The
 * older endpoints that take a member's address sign with the key Kitty holds for a labelled test member
 * (the exit script and the bot use them).
 *
 * A built web (`web/dist`) is served from here too, under the same paths as the pages it replaced
 * (`/`, `/pots/:id`, `/pots/:id/learned`), so one process serves one URL and the bot's links still work.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { readFunds } from "@total-recall/chain";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  type ActionDeps,
  ActionError,
  approve,
  createPot,
  depositCoins,
  joinPot,
  leavePot,
  maybeSuggest,
  potView,
  propose,
  spendAuto,
} from "./actions.ts";
import { BadSignature, ChainAbort, micro } from "./chain.ts";
import { members, memories, pots, proposals, pulls } from "./db/index.ts";
import { createWalletSessions, WalletSessionError, type WalletSessions } from "./wallet.ts";

export interface AppDeps extends ActionDeps {
  keeper: string;
  /** Unsigned wallet transactions waiting for their signature (ADR-0064). */
  sessions?: WalletSessions;
  /** The built web, served at `/` (null: API only). */
  webDist?: string | null;
}

/** The Move aborts a member can hit, in the contract's own words (`pot.move`, `0x2::allowance`). */
export const ABORTS: Record<string, string> = {
  ENotMember: "Only an active member can do this.",
  EAlreadyMember: "You're already a member of this pot.",
  EClosed: "The pot is closed.",
  EBadQuorum: "Quorum must be at least 1.",
  ENoProposal: "No such proposal.",
  EAlreadyApproved: "You already approved this.",
  EUnderQuorum: "Not enough approvals yet.",
  EOverAutoCap: "Above the auto-ok cap: propose it and get the group's approvals.",
  EOverBalance: "The pot doesn't hold that much yet.",
  EExecuted: "Already executed.",
  ETooEarly: "Only a vote can close the pot before its deadline.",
  EFull: "The pot has the most members it can hold.",
  EZeroAmount: "The amount must be more than zero.",
  EExceedsRateLimit: "Above this member's cap for the window.",
};

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
/** JSON with bigints as strings (USDC amounts are micro-dollars). */
const send = (c: Context, data: unknown, status: 200 | 201 = 200) =>
  c.body(JSON.stringify(data, big), status, { "content-type": "application/json; charset=utf-8" });

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,64}$/, "a Sui address")
  .transform((a) => normalizeSuiAddress(a));

const prepareBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    sender: address,
    name: z.string().trim().min(1).max(60),
    goalUsd: z.number().positive().max(1_000_000),
    deadline: z.string().datetime({ offset: true }),
    quorum: z.number().int().min(1).max(50).default(2),
    autoOkUsd: z.number().min(0).default(0),
    windowMinutes: z
      .number()
      .int()
      .positive()
      .default(60 * 24 * 7),
  }),
  z.object({
    action: z.literal("join"),
    sender: address,
    potId: address,
    name: z.string().trim().min(1).max(40),
    capUsd: z.number().positive().max(100_000),
  }),
  z.object({
    action: z.literal("propose"),
    sender: address,
    potId: address,
    kind: z.enum(["spend", "auto_cap", "close"]),
    payee: address.optional(),
    amountUsd: z.number().positive().optional(),
    memo: z.string().trim().max(80).optional(),
    capUsd: z.number().min(0).optional(),
  }),
  z.object({
    action: z.literal("approve"),
    sender: address,
    potId: address,
    seq: z.number().int().min(0),
  }),
  z.object({ action: z.literal("leave"), sender: address, potId: address }),
  z.object({ action: z.literal("deposit"), sender: address }),
]);
export type PrepareBody = z.input<typeof prepareBody>;

export function createApp(deps: AppDeps) {
  const { db } = deps;
  const sessions = deps.sessions ?? createWalletSessions();
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof ActionError) return c.json({ error: err.code, message: err.message }, 409);
    if (err instanceof ChainAbort) {
      const code = err.code;
      return c.json(
        {
          error: "aborted",
          code,
          message: (code && ABORTS[code]) ?? err.detail.slice(0, 300),
          digest: err.digest,
        },
        409,
      );
    }
    if (err instanceof BadSignature)
      return c.json({ error: "bad_signature", message: err.message }, 400);
    if (err instanceof WalletSessionError)
      return c.json({ error: err.code, message: err.message }, err.code === "busy" ? 429 : 409);
    if (err instanceof z.ZodError)
      return c.json({ error: "bad_request", message: err.issues[0]?.message ?? err.message }, 400);
    deps.log?.("http.error", { error: String(err) });
    return c.json({ error: "internal", message: "Something went wrong." }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // ---------- reads ----------

  app.get("/api/config", (c) =>
    c.json({
      network: "testnet",
      packageId: deps.chain.packageId,
      coinType: deps.chain.coinType,
      keeper: deps.keeper,
      sponsor: deps.chain.sponsor,
    }),
  );

  app.get("/api/pots", async (c) => {
    const ps = await db.select().from(pots).orderBy(desc(pots.createdAt)).limit(50);
    const ms = ps.length
      ? await db
          .select()
          .from(members)
          .where(
            inArray(
              members.potId,
              ps.map((p) => p.id),
            ),
          )
      : [];
    return send(
      c,
      ps.map((p) => {
        const mine = ms.filter((m) => m.potId === p.id);
        return {
          ...p,
          totalIn: mine.reduce((s, m) => s + m.contributed, 0n),
          members: mine.filter((m) => m.active).length,
        };
      }),
    );
  });

  app.get("/api/pots/:id", async (c) => {
    const d = await potDetail(deps, c.req.param("id"));
    if (!d) return c.json({ error: "not_found", message: "No such pot." }, 404);
    return send(c, d);
  });

  app.get("/api/pots/:id/memories", async (c) =>
    send(c, await potMemories(deps, c.req.param("id"))),
  );

  /** The wallet's USDC: what the keeper can pull (address balance) and what sits in coins. */
  app.get("/api/wallet/:address", async (c) => {
    const owner = address.parse(c.req.param("address"));
    const funds = await readFunds(deps.chain.client, owner, deps.chain.coinType);
    const mine = await db
      .select({ potId: pots.id, name: pots.name, active: members.active, closed: pots.closed })
      .from(members)
      .innerJoin(pots, eq(pots.id, members.potId))
      .where(eq(members.address, owner))
      .orderBy(desc(pots.createdAt));
    return send(c, {
      address: owner,
      usdc: { addressBalance: funds.addressBalance, coinBalance: funds.coinBalance },
      test: deps.keys.has(owner),
      pots: mine,
    });
  });

  // ---------- the member's own wallet signs (ADR-0064) ----------

  app.post("/api/tx/prepare", async (c) => {
    const b = prepareBody.parse(await c.req.json());
    const start = <T>(act: (d: ActionDeps) => Promise<T>) =>
      sessions.start(b.sender, (signer) => act({ ...deps, signer }));
    switch (b.action) {
      case "create":
        return send(
          c,
          await start((d) =>
            createPot(d, {
              creator: b.sender,
              name: b.name,
              goal: micro(b.goalUsd),
              deadline: new Date(b.deadline),
              quorum: b.quorum,
              autoOkCap: micro(b.autoOkUsd),
              windowMs: b.windowMinutes * 60_000,
              keeper: deps.keeper,
            }),
          ),
        );
      case "join":
        return send(
          c,
          await start((d) =>
            joinPot(d, {
              potId: b.potId,
              member: b.sender,
              name: b.name,
              capPerWindow: micro(b.capUsd),
              test: false,
            }),
          ),
        );
      case "propose": {
        const p =
          b.kind === "spend"
            ? {
                kind: "spend" as const,
                payee: required(b.payee, "payee"),
                amount: micro(required(b.amountUsd, "amountUsd")),
                memo: b.memo ?? "",
              }
            : b.kind === "auto_cap"
              ? { kind: "auto_cap" as const, cap: micro(required(b.capUsd, "capUsd")) }
              : { kind: "close" as const };
        return send(c, await start((d) => propose(d, b.potId, b.sender, p)));
      }
      case "approve": {
        // The approval that reaches quorum executes in the same transaction. Quorum counts active
        // members' approvals and is capped at the number of active members, as in `pot::execute`.
        const exec = await reachesQuorum(deps, b.potId, b.seq);
        try {
          return send(c, await start((d) => approve(d, b.potId, b.seq, b.sender, exec)));
        } catch (err) {
          if (!(exec && err instanceof ChainAbort && err.code === "EUnderQuorum")) throw err;
          return send(c, await start((d) => approve(d, b.potId, b.seq, b.sender, false)));
        }
      }
      case "leave":
        return send(c, await start((d) => leavePot(d, b.potId, b.sender)));
      case "deposit":
        return send(c, await start((d) => depositCoins(d, b.sender)));
    }
  });

  app.post("/api/tx/execute", async (c) => {
    const b = z
      .object({
        digest: z.string().min(32).max(64),
        signature: z.string().min(1),
        bytes: z.string().optional(),
      })
      .parse(await c.req.json());
    return send(c, await sessions.finish(b.digest, b.signature, b.bytes));
  });

  // ---------- labelled test members, signed with the keys Kitty holds ----------

  app.post("/api/pots", async (c) => {
    const b = z
      .object({
        creator: z.string(),
        name: z.string().min(1).max(60),
        goalUsd: z.number().positive(),
        deadline: z.string(),
        quorum: z.number().int().min(1).default(2),
        autoOkUsd: z.number().min(0).default(0),
        windowMinutes: z
          .number()
          .int()
          .positive()
          .default(60 * 24 * 7),
      })
      .parse(await c.req.json());
    return send(
      c,
      await createPot(deps, {
        creator: b.creator,
        name: b.name,
        goal: micro(b.goalUsd),
        deadline: new Date(b.deadline),
        quorum: b.quorum,
        autoOkCap: micro(b.autoOkUsd),
        windowMs: b.windowMinutes * 60_000,
        keeper: deps.keeper,
      }),
      201,
    );
  });

  app.post("/api/pots/:id/join", async (c) => {
    const b = z
      .object({
        member: z.string(),
        name: z.string().min(1).max(40),
        capUsd: z.number().positive(),
      })
      .parse(await c.req.json());
    return send(
      c,
      await joinPot(deps, {
        potId: c.req.param("id"),
        member: b.member,
        name: b.name,
        capPerWindow: micro(b.capUsd),
        test: true,
      }),
      201,
    );
  });

  app.post("/api/pots/:id/proposals", async (c) => {
    const b = z
      .discriminatedUnion("kind", [
        z.object({
          kind: z.literal("spend"),
          proposer: z.string(),
          payee: z.string(),
          amountUsd: z.number().positive(),
          memo: z.string().max(80),
        }),
        z.object({ kind: z.literal("auto_cap"), proposer: z.string(), capUsd: z.number().min(0) }),
        z.object({ kind: z.literal("close"), proposer: z.string() }),
      ])
      .parse(await c.req.json());
    const p =
      b.kind === "spend"
        ? { kind: "spend" as const, payee: b.payee, amount: micro(b.amountUsd), memo: b.memo }
        : b.kind === "auto_cap"
          ? { kind: "auto_cap" as const, cap: micro(b.capUsd) }
          : { kind: "close" as const };
    return send(c, await propose(deps, c.req.param("id"), b.proposer, p), 201);
  });

  app.post("/api/pots/:id/proposals/:seq/approve", async (c) => {
    const b = z
      .object({ member: z.string(), execute: z.boolean().optional() })
      .parse(await c.req.json());
    const potId = c.req.param("id");
    const seq = Number(c.req.param("seq"));
    const exec = b.execute ?? (await reachesQuorum(deps, potId, seq));
    return send(c, await approve(deps, potId, seq, b.member, exec));
  });

  app.post("/api/pots/:id/spend-auto", async (c) => {
    const b = z
      .object({
        member: z.string(),
        payee: z.string(),
        amountUsd: z.number().positive(),
        memo: z.string().max(80),
      })
      .parse(await c.req.json());
    return send(
      c,
      await spendAuto(deps, {
        potId: c.req.param("id"),
        member: b.member,
        payee: b.payee,
        amount: micro(b.amountUsd),
        memo: b.memo,
      }),
      201,
    );
  });

  app.post("/api/pots/:id/leave", async (c) => {
    const b = z.object({ member: z.string() }).parse(await c.req.json());
    return send(c, await leavePot(deps, c.req.param("id"), b.member));
  });

  // ---------- the built web ----------

  const dist = deps.webDist ? resolve(deps.webDist) : null;
  app.get("*", (c) => {
    const path = c.req.path;
    if (path.startsWith("/api/")) return c.json({ error: "not_found" }, 404);
    if (!dist || !existsSync(join(dist, "index.html")))
      return c.text(
        "Kitty's API is up. Run the web with `bun run dev:web` (http://localhost:5182), or `bun run build` to serve it here.",
      );
    const file = normalize(join(dist, decodeURIComponent(path)));
    if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile())
      return c.body(readFileSync(file), 200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        ...(path.startsWith("/assets/")
          ? { "cache-control": "public, max-age=31536000, immutable" }
          : {}),
      });
    // Client-side routes (`/pots/:id`, …) get the app.
    return c.html(readFileSync(join(dist, "index.html"), "utf8"));
  });

  return app;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function required<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw new ActionError("bad_request", `${name} is required.`);
  return v;
}

/** Whether one more approval reaches the quorum `pot::execute` checks. */
async function reachesQuorum(deps: Pick<ActionDeps, "db">, potId: string, seq: number) {
  const [pot] = await deps.db.select().from(pots).where(eq(pots.id, potId));
  const [p] = await deps.db
    .select()
    .from(proposals)
    .where(and(eq(proposals.potId, potId), eq(proposals.seq, seq)));
  if (!pot || !p) throw new ActionError("not_found", "No such proposal.");
  const active = new Set(
    (await deps.db.select().from(members).where(eq(members.potId, potId)))
      .filter((m) => m.active)
      .map((m) => m.address),
  );
  const have = p.approvals.filter((a) => active.has(a.member)).length;
  return have + 1 >= Math.min(pot.quorum, active.size);
}

/** Everything the pot page shows, with each 🧠 reason resolved to its memory and blob. */
export async function potDetail(
  deps: Pick<ActionDeps, "db" | "chain" | "memory" | "log">,
  potId: string,
) {
  const v = await potView(deps, potId);
  if (!v) return null;
  const recent = await deps.db
    .select()
    .from(pulls)
    .where(eq(pulls.potId, potId))
    .orderBy(desc(pulls.createdAt))
    .limit(20);
  const suggestion = v.pot.closed
    ? null
    : await maybeSuggest({ ...deps, keys: new Map() }, potId).catch(() => null);
  const ids = [
    ...v.members.map((m) => m.scheduleMemoryId),
    ...recent.map((p) => p.memoryId),
    suggestion?.memoryId,
  ].filter((x): x is string => !!x);
  const rows = ids.length
    ? await deps.db.select().from(memories).where(inArray(memories.id, ids))
    : [];
  const memo = new Map(rows.map((r) => [r.id, { id: r.id, text: r.text, blobId: r.blobId }]));
  const at = (id: string | null | undefined) => (id ? (memo.get(id) ?? null) : null);
  return {
    pot: v.pot,
    onchain: v.onchain,
    totalIn: v.members.reduce((s, m) => s + m.contributed, 0n),
    members: v.members.map((m) => ({
      address: m.address,
      name: m.name,
      test: m.test,
      active: m.active,
      capPerWindow: m.capPerWindow,
      contributed: m.contributed,
      nextPullAt: m.nextPullAt,
      joinDigest: m.joinDigest,
      reason: at(m.scheduleMemoryId),
    })),
    proposals: v.proposals,
    pulls: recent.map((p) => ({ ...p, memory: at(p.memoryId) })),
    suggestion: suggestion ? { ...suggestion, memory: at(suggestion.memoryId) } : null,
  };
}

export async function potMemories(deps: Pick<ActionDeps, "db">, potId: string) {
  return deps.db
    .select()
    .from(memories)
    .where(like(memories.namespace, `kitty:pot:${potId}:%`))
    .orderBy(desc(memories.createdAt))
    .limit(200);
}

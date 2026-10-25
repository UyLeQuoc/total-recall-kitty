/**
 * Kitty's own Postgres schema (ADR-0062). The chain holds the money and the rules; this mirrors what
 * the web and the keeper need, and indexes every memory so a 🧠 reason can link its blob.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const kitty = pgSchema("kitty");

export interface Approval {
  member: string;
  at: string;
  agent?: string;
  reason?: string;
}

const money = (name: string) => bigint(name, { mode: "bigint" });

export const pots = kitty.table("pots", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  goal: money("goal").notNull(),
  deadline: timestamp("deadline", { withTimezone: true }).notNull(),
  keeper: text("keeper").notNull(),
  quorum: integer("quorum").notNull(),
  autoOkCap: money("auto_ok_cap").notNull(),
  /** The allowance's rate-limit window. */
  windowMs: bigint("window_ms", { mode: "number" }).notNull(),
  coinType: text("coin_type").notNull(),
  createDigest: text("create_digest").notNull(),
  closed: boolean("closed").notNull().default(false),
  telegramChatId: text("telegram_chat_id").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const members = kitty.table(
  "members",
  {
    potId: text("pot_id")
      .notNull()
      .references(() => pots.id),
    address: text("address").notNull(),
    name: text("name").notNull(),
    test: boolean("test").notNull().default(false),
    capPerWindow: money("cap_per_window").notNull(),
    allowanceId: text("allowance_id").notNull(),
    allowanceCapId: text("allowance_cap_id").notNull(),
    allowanceName: text("allowance_name").notNull(),
    joinDigest: text("join_digest").notNull(),
    active: boolean("active").notNull().default(true),
    contributed: money("contributed").notNull().default(sql`0`),
    /** When the keeper next tries a pull; null = as soon as possible. */
    nextPullAt: timestamp("next_pull_at", { withTimezone: true }),
    /** The memory behind the current schedule, if any. */
    scheduleMemoryId: text("schedule_memory_id"),
    telegramUserId: text("telegram_user_id"),
  },
  (t) => [primaryKey({ columns: [t.potId, t.address] })],
);

/** Every pull the keeper considered: sent, skipped (no transaction) or aborted onchain. */
export const pulls = kitty.table(
  "pulls",
  {
    id: text("id").primaryKey(),
    potId: text("pot_id").notNull(),
    member: text("member").notNull(),
    amount: money("amount").notNull(),
    status: text("status").notNull(),
    digest: text("digest"),
    reason: text("reason").notNull(),
    memoryId: text("memory_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pulls_pot").on(t.potId, t.createdAt)],
);

export const proposals = kitty.table(
  "proposals",
  {
    potId: text("pot_id").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    payee: text("payee"),
    amount: money("amount"),
    memo: text("memo"),
    proposer: text("proposer").notNull(),
    /** `agent`: the member's delegate approved for them (KT4, ADR-0067), with its `reason`. */
    approvals: jsonb("approvals").$type<Approval[]>().notNull().default([]),
    /** The delegate that proposed it for `proposer`, if an agent did. */
    proposerAgent: text("proposer_agent"),
    executed: boolean("executed").notNull().default(false),
    digest: text("digest"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.potId, t.seq] })],
);

export const spends = kitty.table("spends", {
  id: text("id").primaryKey(),
  potId: text("pot_id").notNull(),
  payee: text("payee").notNull(),
  amount: money("amount").notNull(),
  memo: text("memo").notNull(),
  auto: boolean("auto").notNull(),
  proposalSeq: integer("proposal_seq"),
  digest: text("digest").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Money that arrived at a member's address, seen by the keeper's filtered stream. */
export const inflows = kitty.table(
  "inflows",
  {
    digest: text("digest").notNull(),
    member: text("member").notNull(),
    potId: text("pot_id").notNull(),
    amount: money("amount").notNull(),
    checkpoint: bigint("checkpoint", { mode: "number" }),
    memoryId: text("memory_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.digest, t.member, t.potId] })],
);

export const memories = kitty.table(
  "memories",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull(),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    sha256: text("sha256").notNull(),
    jobId: text("job_id"),
    blobId: text("blob_id"),
    status: text("status").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("kitty_memories_ns").on(t.namespace, t.createdAt)],
);

/** A member's delegate agent (KT4, ADR-0067): the current one is the latest active row. */
export const delegates = kitty.table(
  "delegates",
  {
    id: text("id").primaryKey(),
    potId: text("pot_id").notNull(),
    member: text("member").notNull(),
    agent: text("agent").notNull(),
    approveCap: money("approve_cap").notNull(),
    active: boolean("active").notNull().default(true),
    setDigest: text("set_digest").notNull(),
    revokeDigest: text("revoke_digest"),
    memoryId: text("memory_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("delegates_pot").on(t.potId, t.member)],
);

/** Read-only remote MCP tokens (ADR-0067): only the SHA-256 is kept; one pot each. */
export const mcpTokens = kitty.table(
  "mcp_tokens",
  {
    id: text("id").primaryKey(),
    potId: text("pot_id").notNull(),
    member: text("member").notNull(),
    name: text("name").notNull(),
    sha256: text("sha256").notNull().unique(),
    calls: integer("calls").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("mcp_tokens_pot").on(t.potId)],
);

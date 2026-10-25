/** hippo's types plus Remora's (rule … wake); mirrors `@remora/schema` `MEMORY_TYPES`. */
export const MEMORY_TYPES = [
  "profile",
  "decision",
  "gotcha",
  "commitment",
  "correction",
  "style",
  "rule",
  "episode",
  "source",
  "feedback",
  "budget",
  "handoff",
  "wake",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryRecord {
  type: MemoryType;
  tags: Record<string, string>;
  date: string;
  text: string;
}

export interface BuildMemoryInput {
  type: MemoryType;
  by: string;
  channel?: string;
  date?: Date;
  text: string;
  replaces?: string;
}

export function isMemoryType(v: string): v is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(v);
}

export function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Our own tags at the start of a fact, and only those shapes. The model reads
 * recalled memories in this format and sometimes copies the prefix into the
 * text it asks to store, which produced lines like
 * `[style] [by:@mai] [#demo] [2026-09-24] [by:@mai] [#demo] [2026-09-24] …`
 * on mainnet. A bracket that is not one of ours, like `[WIP]`, is content.
 */
const COPIED_TAGS = new RegExp(
  `^\\s*(?:\\[(?:${MEMORY_TYPES.join("|")}|by:[^\\]]*|#[^\\]]*|replaces:[^\\]]*|\\d{4}-\\d{2}-\\d{2})\\]\\s*)+`,
);

export function replacesBlobId(value: string | undefined): string | null {
  if (!value) return null;
  const id = value.trim();
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(id)) return null;
  return id;
}

/** `[type] [by:@handle] [#channel]? [YYYY-MM-DD] fact` */
export function buildMemoryText(input: BuildMemoryInput): string {
  const parts = [`[${input.type}]`, `[by:@${input.by.replace(/^@/, "")}]`];
  if (input.channel) parts.push(`[#${input.channel.replace(/^#/, "")}]`);
  const replaces = replacesBlobId(input.replaces);
  if (replaces) parts.push(`[replaces:${replaces}]`);
  parts.push(`[${isoDate(input.date)}]`);
  parts.push(input.text.replace(COPIED_TAGS, "").trim().replace(/\s+/g, " "));
  return parts.join(" ");
}

const HEAD = /^\[([a-z]+)\]\s*((?:\[[^\]]+\]\s*)*)(.*)$/s;
const TAG = /\[([^\]]+)\]/g;

export function parseMemoryText(raw: string): MemoryRecord | null {
  const m = HEAD.exec(raw.trim());
  if (!m) return null;
  const [, typeRaw, tagBlock, rest] = m;
  if (!typeRaw || !isMemoryType(typeRaw)) return null;
  const tags: Record<string, string> = {};
  let date = "";
  for (const t of (tagBlock ?? "").matchAll(TAG)) {
    const v = t[1] ?? "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) date = v;
    else if (v.startsWith("#")) tags.channel = v.slice(1);
    else if (v.includes(":")) {
      const [k, ...val] = v.split(":");
      if (k) tags[k] = val.join(":").replace(/^@/, "");
    }
  }
  return { type: typeRaw, tags, date, text: (rest ?? "").trim() };
}

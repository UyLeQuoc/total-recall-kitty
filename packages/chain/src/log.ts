/**
 * K1: the structured (JSON-lines) logger every chain-touching service shares: the server, the
 * facilitator and the merchants. Secrets never reach the output: keys whose name looks secret are
 * dropped, and values that look like Sui private keys or 64-hex secrets are masked wherever they are.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const SECRET_KEY =
  /secret|private|password|passphrase|mnemonic|api[-_]?key|authorization|cookie|(^|[-_])token$|Token$|^token$|seed$|^kek$|^dek$/i;
// Object IDs and addresses are 0x + 64 hex and must stay readable; bare 64-hex strings are treated as
// secrets (KEK, raw private keys), as are `suiprivkey1…` strings.
const BARE_HEX64 = /(?<!0x)\b[0-9a-fA-F]{64}\b/g;
const SUI_PRIVKEY = /suiprivkey1[0-9a-z]+/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") {
    return value.replace(SUI_PRIVKEY, "[redacted]").replace(BARE_HEX64, "[redacted]");
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `[${value.length} bytes]`;
  if (value instanceof Error)
    return { name: value.name, message: redact(value.message, depth + 1) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * K1 (ADR-0052): fields every log line inherits while a request or a job runs (`requestId`,
 * `jobId`). Set with `withLogContext`; read by every logger, whatever its `base`.
 */
const logContext = new AsyncLocalStorage<LogFields>();

export function withLogContext<T>(fields: LogFields, fn: () => T): T {
  return logContext.run({ ...logContext.getStore(), ...fields }, fn);
}

export const currentLogContext = (): LogFields => logContext.getStore() ?? {};

export function createLogger(
  base: LogFields = {},
  write: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
  minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info",
): Logger {
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (order[level] < order[minLevel]) return;
    const entry = redact({
      ts: new Date().toISOString(),
      level,
      msg,
      ...logContext.getStore(),
      ...base,
      ...fields,
    });
    write(JSON.stringify(entry));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger({ ...base, ...fields }, write, minLevel),
  };
}

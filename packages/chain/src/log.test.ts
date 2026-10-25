import { describe, expect, it } from "vitest";
import { createLogger, redact, withLogContext } from "./log.ts";

describe("logger (K1)", () => {
  it("writes JSON lines with base and per-call fields", () => {
    const lines: string[] = [];
    const log = createLogger({ service: "test" }, (l) => lines.push(l), "debug").child({
      network: "testnet",
    });
    log.info("paid", { remora: "r1", amount: 10n });
    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry).toMatchObject({
      level: "info",
      msg: "paid",
      service: "test",
      network: "testnet",
      remora: "r1",
      amount: "10",
    });
  });

  it("drops below the minimum level", () => {
    const lines: string[] = [];
    createLogger({}, (l) => lines.push(l), "warn").info("quiet");
    expect(lines).toHaveLength(0);
  });

  it("never prints secrets: secret-named fields, sui private keys, bare 64-hex", () => {
    const out = JSON.stringify(
      redact({
        SPONSOR_PRIVATE_KEY: "suiprivkey1qabc",
        apiKey: "t-123",
        sealed: { dek: "x" },
        note: "key suiprivkey1qzzz9 leaked",
        kek: "c".repeat(64),
        raw: "a".repeat(64),
        objectId: `0x${"a".repeat(64)}`,
        promptTokens: 12,
      }),
    );
    expect(out).not.toMatch(/suiprivkey1q/);
    expect(out).not.toMatch(/t-123/);
    expect(out).not.toMatch(/"a{64}"/);
    expect(out).toContain(`0x${"a".repeat(64)}`);
    expect(out).toContain('"promptTokens":12');
  });

  it("keeps errors readable without stack traces", () => {
    expect(redact(new Error("boom"))).toEqual({ name: "Error", message: "boom" });
  });

  it("adds the request or job context to every line written inside it (ADR-0052)", async () => {
    const lines: string[] = [];
    const log = createLogger({ service: "t" }, (l) => lines.push(l));
    await withLogContext({ requestId: "r-1" }, async () => {
      await Promise.resolve();
      log.info("inside");
      withLogContext({ jobId: "j-1" }, () => log.child({ x: 1 }).warn("nested"));
    });
    log.info("outside");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ msg: "inside", requestId: "r-1" });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ requestId: "r-1", jobId: "j-1", x: 1 });
    expect(JSON.parse(lines[2] ?? "{}").requestId).toBeUndefined();
  });
});

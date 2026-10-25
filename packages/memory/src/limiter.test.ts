import { describe, expect, it, vi } from "vitest";
import { limiterFor, RateLimiter, runLimited } from "./limiter.ts";

describe("RateLimiter", () => {
  it("never runs more than `concurrency` at once", async () => {
    const limiter = new RateLimiter({ capacity: 100, concurrency: 2 });
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        limiter.run(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(inFlight).toBe(0);
  });

  it("releases its slot when the call throws", async () => {
    const limiter = new RateLimiter({ capacity: 100, concurrency: 1 });
    await expect(
      limiter.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A second call would hang forever if the failed one kept the slot.
    await expect(limiter.run(async () => "fine")).resolves.toBe("fine");
  });

  it("holds requests back once the window budget is spent", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter({ capacity: 2, windowMs: 1_000, concurrency: 5 });
      const done: number[] = [];
      const runs = [0, 1, 2].map((i) => limiter.run(async () => void done.push(i)));
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1_100);
      await Promise.all(runs);
      expect(done).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives every client of one delegate key the same budget", () => {
    expect(limiterFor("key-a")).toBe(limiterFor("key-a"));
    expect(limiterFor("key-a")).not.toBe(limiterFor("key-b"));
  });
});

describe("runLimited", () => {
  it("waits out a 429 and retries", async () => {
    const limiter = new RateLimiter({ capacity: 100, concurrency: 4 });
    let calls = 0;
    const result = await runLimited(limiter, async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("429"), { status: 429, retryAfterSeconds: 0 });
      return "second time lucky";
    });
    expect(calls).toBe(2);
    expect(result).toBe("second time lucky");
  });

  it("passes other failures straight through without retrying", async () => {
    const limiter = new RateLimiter({ capacity: 100, concurrency: 4 });
    let calls = 0;
    await expect(
      runLimited(limiter, async () => {
        calls++;
        throw Object.assign(new Error("nope"), { status: 401 });
      }),
    ).rejects.toThrow("nope");
    expect(calls).toBe(1);
  });
});

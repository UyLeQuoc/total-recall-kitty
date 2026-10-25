/**
 * The relayer rate-limits the write path per delegate key. Observed on mainnet
 * 2026-09-21: `60 weighted-requests/min` (the public docs say 30). Guest mode
 * shares one delegate key across every user, so requests must be paced in
 * process or a burst returns 429 for everyone.
 */
export interface LimiterOptions {
  /** Requests allowed per window. Default 50, under the observed 60. */
  capacity?: number;
  /** Window in ms. Default 60_000. */
  windowMs?: number;
  /**
   * Max requests in flight at once. Default 2.
   *
   * Kept low deliberately. The relayer appears to share a SEAL decrypt pool that
   * is capped at three concurrent decrypts, and under concurrent recalls it
   * starts answering with an empty result plus a non-zero `dropped_count`
   * instead of queueing. Fewer requests in flight means fewer dropped recalls,
   * which matters more than latency here. See docs/SPIKES.md §H.
   */
  concurrency?: number;
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly windowMs: number;
  private readonly concurrency: number;
  private stamps: number[] = [];
  private active = 0;
  private queue: Array<() => void> = [];

  constructor({ capacity = 50, windowMs = 60_000, concurrency = 2 }: LimiterOptions = {}) {
    this.capacity = capacity;
    this.windowMs = windowMs;
    this.concurrency = concurrency;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.active--;
      this.pump();
    }
  }

  private acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
  }

  private pump(): void {
    if (!this.queue.length || this.active >= this.concurrency) return;
    const now = Date.now();
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
    if (this.stamps.length >= this.capacity) {
      const oldest = this.stamps[0] ?? now;
      setTimeout(() => this.pump(), Math.max(50, this.windowMs - (now - oldest) + 50));
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    this.stamps.push(now);
    this.active++;
    next();
  }
}

/** One limiter per delegate key, so every client sharing a key shares a budget. */
const limiters = new Map<string, RateLimiter>();
export function limiterFor(delegateKey: string, options?: LimiterOptions): RateLimiter {
  const existing = limiters.get(delegateKey);
  if (existing) return existing;
  const created = new RateLimiter(options);
  limiters.set(delegateKey, created);
  return created;
}

interface RateLimitedError {
  status?: number;
  retryAfterSeconds?: number;
  message?: string;
}

/**
 * Errors worth waiting out. A 429 is the relayer's own budget. The others are
 * the relayer failing to reach something it depends on: seen in production as
 * "temporarily cannot verify credentials (upstream unavailable)", which is its
 * Sui RPC being unreachable while it checks our delegate key. None of these
 * mean the request was wrong, so none of them should surface to a user.
 */
function retryAfterMs(err: unknown): number | null {
  const e = err as RateLimitedError | null;
  if (!e) return null;
  if (e.status === 429) {
    const secs = typeof e.retryAfterSeconds === "number" ? e.retryAfterSeconds : 60;
    return Math.max(1_000, secs * 1_000 + 500);
  }
  if (e.status === 502 || e.status === 503 || e.status === 504) return 2_000;
  if (
    typeof e.message === "string" &&
    /upstream unavailable|temporarily cannot verify/i.test(e.message)
  ) {
    return 2_000;
  }
  return null;
}

/**
 * Run through the limiter and, if the relayer still says 429, wait out its
 * `retry_after_seconds` and try again. The limiter paces our own traffic; this
 * covers a budget already spent by another process sharing the delegate key.
 */
export async function runLimited<T>(
  limiter: RateLimiter,
  fn: () => Promise<T>,
  tries = 4,
): Promise<T> {
  let lastError: unknown;
  for (let i = 1; i <= tries; i++) {
    try {
      return await limiter.run(fn);
    } catch (err) {
      lastError = err;
      const waitMs = retryAfterMs(err);
      if (waitMs === null || i === tries) throw err;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastError;
}

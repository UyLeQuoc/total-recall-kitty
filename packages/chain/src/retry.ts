/**
 * gRPC status codes worth retrying: the call never reached the chain, or was rate-limited. Tatum's
 * HTTP 429 arrives as UNAVAILABLE ("Received HTTP status code 429").
 */
const RETRYABLE = new Set(["UNAVAILABLE", "DEADLINE_EXCEEDED", "RESOURCE_EXHAUSTED", "ABORTED"]);

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
}

export function isRetryable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE.has(code);
}

/**
 * Retries reads and simulations. Don't wrap `executeTransaction` blindly: an UNAVAILABLE after
 * submission can still land, so look the digest up before resubmitting.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 500;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isRetryable(err)) throw err;
      await new Promise((r) => setTimeout(r, base * 2 ** (i - 1)));
    }
  }
}

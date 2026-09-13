export type RateLimitDecision = {
  allowed: boolean;
  /** Number of times this stack has been forwarded inside the current window. */
  seenInWindow: number;
  /** When the current window expires — useful for logging back-pressure. */
  resetsAt: Date;
};

export type StackRateLimiterOptions = {
  maxPerWindow: number;
  windowMs: number;
  /** Time provider — injectable so tests can drive a fake clock. */
  now?: () => Date;
};

type BucketState = {
  /** Sorted, ascending. Each entry is the timestamp when a hit was recorded. */
  hits: number[];
};

/**
 * In-process sliding-window rate limiter keyed by stack hash.
 *
 * Keeps a per-key array of hit timestamps. A new hit is allowed when fewer
 * than `maxPerWindow` timestamps fall inside `[now - windowMs, now]`.
 *
 * Not safe across multiple processes — Discord bots run as a single Node
 * process so this is sufficient.
 */
export class StackRateLimiter {
  readonly maxPerWindow: number;

  readonly windowMs: number;

  private readonly now: () => Date;

  private readonly buckets = new Map<string, BucketState>();

  constructor(options: StackRateLimiterOptions) {
    this.maxPerWindow = options.maxPerWindow;
    this.windowMs = options.windowMs;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Record a hit for `key` and return the limiter's decision.
   * When the hit is allowed the timestamp is stored; when it is denied the
   * timestamp is intentionally discarded so denied events do not extend the
   * back-pressure window artificially.
   */
  hit(key: string): RateLimitDecision {
    const nowMs = this.now().getTime();
    const windowStart = nowMs - this.windowMs;
    const bucket = this.buckets.get(key) ?? { hits: [] };
    const fresh = bucket.hits.filter((hit) => hit > windowStart);

    if (fresh.length >= this.maxPerWindow) {
      this.buckets.set(key, { hits: fresh });
      const resetsAt = new Date(fresh[0] + this.windowMs);
      return { allowed: false, seenInWindow: fresh.length, resetsAt };
    }

    fresh.push(nowMs);
    this.buckets.set(key, { hits: fresh });
    return {
      allowed: true,
      seenInWindow: fresh.length,
      resetsAt: new Date(nowMs + this.windowMs),
    };
  }

  /** Number of distinct stack signatures currently being tracked. */
  size(): number {
    return this.buckets.size;
  }

  /** Forget every recorded hit. Mostly useful from tests. */
  reset(): void {
    this.buckets.clear();
  }
}

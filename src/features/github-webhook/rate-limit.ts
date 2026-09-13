/**
 * Per-source-repo rate limit. GitHub's webhook deliveries are at-least-once;
 * a noisy repo can otherwise spam a Discord channel. We track the most
 * recent delivery timestamp per repo and reject anything that arrives within
 * the configured window.
 *
 * The class is intentionally tiny and dependency-free — callers can pass
 * their own `now()` for deterministic tests.
 */
export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export class GitHubWebhookRateLimiter {
  private readonly lastSeenAt = new Map<string, number>();

  constructor(private readonly windowMs: number) {
    if (!Number.isFinite(windowMs) || windowMs < 0) {
      throw new Error(`windowMs must be a non-negative finite number, got ${windowMs}`);
    }
  }

  /**
   * Check whether a new event from `repoKey` may proceed.
   *
   * Returns the decision along with the recommended retry-after window
   * when the request is throttled.
   */
  check(repoKey: string, now: number = Date.now()): RateLimitDecision {
    const previous = this.lastSeenAt.get(repoKey);
    if (previous !== undefined) {
      const elapsed = now - previous;
      if (elapsed < this.windowMs) {
        return { allowed: false, retryAfterMs: this.windowMs - elapsed };
      }
    }
    this.lastSeenAt.set(repoKey, now);
    return { allowed: true };
  }

  /** Number of repos currently being tracked (mostly useful for tests). */
  size(): number {
    return this.lastSeenAt.size;
  }

  /** Drop a tracked repo (e.g. for cleanup in tests). */
  forget(repoKey: string): void {
    this.lastSeenAt.delete(repoKey);
  }
}
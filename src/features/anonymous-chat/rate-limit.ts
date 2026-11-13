/**
 * In-memory per-user cooldown for `/anon` attempts (ADR-0003 §2).
 *
 * The map is intentionally process-local and never persisted: it holds
 * Discord user ids only for the lifetime of the cooldown window, is
 * never written to disk, and is never passed to any logger.
 */
export class AnonCooldown {
  private readonly hits = new Map<string, number>();

  constructor(
    private readonly cooldownMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Record an attempt for `userId`. Returns `0` when the attempt is
   * allowed, or the remaining cooldown in milliseconds when the user is
   * still cooling down. Every call consumes the window — including
   * attempts that later fail authorization — so permission probing is
   * bounded too.
   */
  hit(userId: string): number {
    const current = this.now();
    this.prune(current);

    const last = this.hits.get(userId);
    if (last !== undefined && current - last < this.cooldownMs) {
      return this.cooldownMs - (current - last);
    }
    this.hits.set(userId, current);
    return 0;
  }

  get size(): number {
    return this.hits.size;
  }

  private prune(current: number): void {
    // Bound memory: sweep expired entries once the map grows large.
    if (this.hits.size < 10_000) {
      return;
    }
    for (const [userId, at] of this.hits) {
      if (current - at >= this.cooldownMs) {
        this.hits.delete(userId);
      }
    }
  }
}

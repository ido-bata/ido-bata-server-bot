/**
 * Snapshot returned from `GameActivityTracker.snapshot()`. Caller must treat
 * the returned sets as read-only.
 */
export type GameActivitySnapshot = {
  collectedAt: number;
  entries: { gameName: string; userIds: Set<string> }[];
  totalPlayers: number;
};

export type GameActivityTrackerOptions = {
  now?: () => number;
  staleAfterMs: number;
};

export type GameActivityObserver = {
  readonly userId: string;
  readonly gameName: string;
  readonly observedAt: number;
};

/**
 * Tracks which members are currently playing a whitelisted game. The tracker
 * is the only stateful piece of the feature; the handler is a thin adapter
 * from Discord events into tracker mutations.
 *
 * Staleness rule: a member is considered active if their last observation
 * is younger than `staleAfterMs`. `evict(now)` removes everyone older than
 * the threshold so the rendered channel message never lists ghost players.
 */
export class GameActivityTracker {
  readonly #staleAfterMs: number;

  readonly #now: () => number;

  readonly #byUser: Map<string, GameActivityObserver> = new Map();

  constructor(options: GameActivityTrackerOptions) {
    if (!Number.isFinite(options.staleAfterMs) || options.staleAfterMs <= 0) {
      throw new Error("GameActivityTracker requires a positive staleAfterMs");
    }
    this.#staleAfterMs = options.staleAfterMs;
    this.#now = options.now ?? Date.now;
  }

  observe(userId: string, gameName: string, observedAt: number = this.#now()): void {
    if (!userId) {
      return;
    }
    const trimmed = gameName.trim();
    if (!trimmed) {
      return;
    }
    this.#byUser.set(userId, { userId, gameName: trimmed, observedAt });
  }

  clear(userId: string): void {
    this.#byUser.delete(userId);
  }

  /**
   * Removes entries whose last observation is older than the staleness
   * threshold. Returns the user IDs that were evicted so the caller can
   * decide whether to re-render the channel message.
   */
  evict(now: number = this.#now()): string[] {
    const evicted: string[] = [];
    for (const [userId, observer] of this.#byUser) {
      if (now - observer.observedAt > this.#staleAfterMs) {
        evicted.push(userId);
      }
    }
    for (const userId of evicted) {
      this.#byUser.delete(userId);
    }
    return evicted;
  }

  hasObservers(): boolean {
    return this.#byUser.size > 0;
  }

  /**
   * Returns a per-game aggregation grouped by the canonical (whitelisted)
   * game name. The result is sorted by descending player count then by game
   * name so the rendered message is deterministic.
   */
  snapshot(now: number = this.#now()): GameActivitySnapshot {
    const perGame = new Map<string, Set<string>>();
    for (const observer of this.#byUser.values()) {
      if (now - observer.observedAt > this.#staleAfterMs) {
        continue;
      }
      const bucket = perGame.get(observer.gameName);
      if (bucket) {
        bucket.add(observer.userId);
      } else {
        perGame.set(observer.gameName, new Set([observer.userId]));
      }
    }

    const entries = [...perGame.entries()]
      .map(([gameName, userIds]) => ({ gameName, userIds }))
      .sort((left, right) => {
        const countDiff = right.userIds.size - left.userIds.size;
        if (countDiff !== 0) {
          return countDiff;
        }
        return left.gameName.localeCompare(right.gameName);
      });

    const totalPlayers = entries.reduce((total, entry) => total + entry.userIds.size, 0);

    return {
      collectedAt: now,
      entries,
      totalPlayers,
    };
  }
}

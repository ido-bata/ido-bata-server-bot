import type { SpotifyTrack } from "./activity.js";

export type StoredNowPlaying = {
  userId: string;
  guildId: string;
  displayName: string;
  track: SpotifyTrack;
  embedMessageId: string | null;
  lastUpdatedAt: number;
};

export type StaleReason = "stale";

export class NowPlayingStore {
  private readonly entries = new Map<string, StoredNowPlaying>();
  private readonly staleAfterMs: number;

  constructor(staleAfterMs: number) {
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
      throw new Error("staleAfterMs must be a positive number");
    }
    this.staleAfterMs = staleAfterMs;
  }

  get staleThresholdMs(): number {
    return this.staleAfterMs;
  }

  size(): number {
    return this.entries.size;
  }

  set(entry: StoredNowPlaying): void {
    this.entries.set(entry.userId, entry);
  }

  get(userId: string): StoredNowPlaying | undefined {
    return this.entries.get(userId);
  }

  delete(userId: string): boolean {
    return this.entries.delete(userId);
  }

  values(): StoredNowPlaying[] {
    return Array.from(this.entries.values());
  }

  pruneStale(now: number): StoredNowPlaying[] {
    const stale: StoredNowPlaying[] = [];
    for (const [userId, entry] of this.entries) {
      if (now - entry.lastUpdatedAt > this.staleAfterMs) {
        this.entries.delete(userId);
        stale.push(entry);
      }
    }
    return stale;
  }

  clear(): void {
    this.entries.clear();
  }

  isStale(entry: StoredNowPlaying, now: number): boolean {
    return now - entry.lastUpdatedAt > this.staleAfterMs;
  }

  isSameTrack(entry: StoredNowPlaying, track: SpotifyTrack): boolean {
    return (
      entry.track.title === track.title &&
      entry.track.artist === track.artist &&
      entry.track.trackId === track.trackId
    );
  }
}
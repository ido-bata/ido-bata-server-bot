import { describe, expect, it } from "vitest";

import { NowPlayingStore, type StoredNowPlaying } from "../src/features/spotify/state.js";

const track = {
  title: "Never Gonna Give You Up",
  artist: "Rick Astley",
  album: "Whenever You Need Somebody",
  startedAtMs: 1_700_000_000_000,
  endsAtMs: 1_700_000_180_000,
  trackId: "4uLU6hMCjMI75M1A2tKUQC",
};

function buildEntry(overrides: Partial<StoredNowPlaying> = {}): StoredNowPlaying {
  return {
    userId: "user-1",
    guildId: "guild-1",
    displayName: "alice",
    track,
    embedMessageId: "msg-1",
    lastUpdatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("NowPlayingStore", () => {
  it("rejects a non-positive stale threshold", () => {
    expect(() => new NowPlayingStore(0)).toThrow();
    expect(() => new NowPlayingStore(-1)).toThrow();
  });

  it("stores and retrieves entries by user id", () => {
    const store = new NowPlayingStore(1_000);
    const entry = buildEntry();
    store.set(entry);
    expect(store.get("user-1")).toBe(entry);
    expect(store.size()).toBe(1);
  });

  it("deletes entries and reports the deletion", () => {
    const store = new NowPlayingStore(1_000);
    store.set(buildEntry());
    expect(store.delete("user-1")).toBe(true);
    expect(store.get("user-1")).toBeUndefined();
    expect(store.delete("user-1")).toBe(false);
  });

  it("returns true for isStale once the threshold has elapsed", () => {
    const store = new NowPlayingStore(1_000);
    const entry = buildEntry({ lastUpdatedAt: 1_000 });
    expect(store.isStale(entry, 1_999)).toBe(false);
    expect(store.isStale(entry, 2_001)).toBe(true);
  });

  it("prunes entries whose lastUpdatedAt exceeds the threshold", () => {
    const store = new NowPlayingStore(1_000);
    store.set(buildEntry({ userId: "user-1", lastUpdatedAt: 1_000 }));
    store.set(buildEntry({ userId: "user-2", lastUpdatedAt: 5_000 }));
    const stale = store.pruneStale(5_500);
    expect(stale.map((entry) => entry.userId).sort()).toEqual(["user-1"]);
    expect(store.size()).toBe(1);
    expect(store.get("user-1")).toBeUndefined();
    expect(store.get("user-2")).toBeDefined();
  });

  it("does not prune entries within the threshold window", () => {
    const store = new NowPlayingStore(60_000);
    store.set(buildEntry({ lastUpdatedAt: 1_000 }));
    expect(store.pruneStale(1_500)).toEqual([]);
    expect(store.size()).toBe(1);
  });

  it("compares track identity by title, artist and track id", () => {
    const store = new NowPlayingStore(60_000);
    const entry = buildEntry();
    expect(store.isSameTrack(entry, { ...track })).toBe(true);
    expect(
      store.isSameTrack(entry, { ...track, title: "Together Forever" }),
    ).toBe(false);
    expect(
      store.isSameTrack(entry, { ...track, artist: "Different Artist" }),
    ).toBe(false);
    expect(
      store.isSameTrack(entry, { ...track, trackId: "different-id" }),
    ).toBe(false);
  });

  it("clears all entries", () => {
    const store = new NowPlayingStore(60_000);
    store.set(buildEntry({ userId: "user-1" }));
    store.set(buildEntry({ userId: "user-2" }));
    store.clear();
    expect(store.size()).toBe(0);
  });
});
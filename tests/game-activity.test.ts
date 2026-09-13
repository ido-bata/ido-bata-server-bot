import { describe, expect, it, vi } from "vitest";

import {
  gameActivityConfig as defaultConfig,
  findWhitelistedGame,
  type GameActivityConfig,
  isGameActivityConfigured,
  normalizeGameName,
} from "../src/features/game-activity/config.js";
import {
  formatGameActivityMessage,
  summarizeGameActivity,
} from "../src/features/game-activity/formatter.js";
import {
  createGameActivityHandler,
  type GameActivityMessageTarget,
  pickWhitelistedPlayingGame,
} from "../src/features/game-activity/handler.js";
import { GameActivityTracker } from "../src/features/game-activity/tracker.js";

const baseConfig: GameActivityConfig = {
  enabled: true,
  channelId: "channel-1",
  whitelistedGames: ["Apex Legends", "VALORANT", "Minecraft"],
  staleAfterMs: 5 * 60_000,
  refreshIntervalMs: 60_000,
};

describe("game-activity config", () => {
  it("normalizes whitespace and case when matching the whitelist", () => {
    expect(normalizeGameName("  apex LEGENDS  ")).toBe("apex legends");
  });

  it("returns the canonical whitelist entry for an activity name", () => {
    expect(findWhitelistedGame(baseConfig, "valorant")).toBe("VALORANT");
    expect(findWhitelistedGame(baseConfig, "Apex Legends")).toBe("Apex Legends");
    expect(findWhitelistedGame(baseConfig, "Stardew Valley")).toBeNull();
  });

  it("rejects empty activity names", () => {
    expect(findWhitelistedGame(baseConfig, "   ")).toBeNull();
  });

  it("treats the feature as unconfigured until enabled + channel + whitelist are set", () => {
    expect(isGameActivityConfigured({ ...defaultConfig })).toBe(false);
    expect(isGameActivityConfigured({ ...defaultConfig, enabled: true })).toBe(false);
    expect(isGameActivityConfigured({ ...defaultConfig, enabled: true, channelId: "x" })).toBe(
      false,
    );
    expect(isGameActivityConfigured(baseConfig)).toBe(true);
  });
});

describe("pickWhitelistedPlayingGame", () => {
  it("ignores activities whose type is not Playing", () => {
    expect(
      pickWhitelistedPlayingGame(baseConfig, {
        userId: "user-1",
        activities: [{ name: "Apex Legends", type: 2 }], // Listening
      }),
    ).toBeNull();
  });

  it("ignores activities whose name is not in the whitelist", () => {
    expect(
      pickWhitelistedPlayingGame(baseConfig, {
        userId: "user-1",
        activities: [{ name: "Stardew Valley", type: 0 }],
      }),
    ).toBeNull();
  });

  it("returns the canonical whitelist entry for a Playing match", () => {
    expect(
      pickWhitelistedPlayingGame(baseConfig, {
        userId: "user-1",
        activities: [
          { name: "VALORANT", type: 0 },
          { name: "Spotify", type: 2 },
        ],
      }),
    ).toEqual({ userId: "user-1", gameName: "VALORANT" });
  });

  it("returns null when the snapshot has no userId", () => {
    expect(
      pickWhitelistedPlayingGame(baseConfig, {
        userId: "",
        activities: [{ name: "Apex Legends", type: 0 }],
      }),
    ).toBeNull();
  });
});

describe("GameActivityTracker", () => {
  it("records and aggregates observers by game", () => {
    const tracker = new GameActivityTracker({ staleAfterMs: 5 * 60_000 });
    tracker.observe("alice", "Apex Legends", 1_000);
    tracker.observe("bob", "Apex Legends", 1_500);
    tracker.observe("carol", "VALORANT", 2_000);

    const snapshot = tracker.snapshot(2_000);
    expect(snapshot.totalPlayers).toBe(3);
    expect(snapshot.entries.map((entry) => [entry.gameName, entry.userIds.size])).toEqual([
      ["Apex Legends", 2],
      ["VALORANT", 1],
    ]);
  });

  it("removes stale observers on demand", () => {
    const tracker = new GameActivityTracker({ staleAfterMs: 5 * 60_000 });
    tracker.observe("alice", "Apex Legends", 1_000);

    const evicted = tracker.evict(10 * 60_000);
    expect(evicted).toEqual(["alice"]);
    expect(tracker.hasObservers()).toBe(false);
  });

  it("keeps recent observers when sweeping for stale entries", () => {
    const tracker = new GameActivityTracker({ staleAfterMs: 5 * 60_000 });
    tracker.observe("alice", "Apex Legends", 0);
    tracker.observe("bob", "VALORANT", 9 * 60_000);

    tracker.evict(10 * 60_000);
    const snapshot = tracker.snapshot(10 * 60_000);
    expect(snapshot.entries.map((entry) => entry.gameName)).toEqual(["VALORANT"]);
  });

  it("clears a single user via clear()", () => {
    const tracker = new GameActivityTracker({ staleAfterMs: 5 * 60_000 });
    tracker.observe("alice", "Apex Legends", 1_000);
    tracker.observe("bob", "Apex Legends", 1_000);

    tracker.clear("alice");

    const snapshot = tracker.snapshot(1_000);
    expect([...(snapshot.entries[0]?.userIds ?? [])]).toEqual(["bob"]);
  });

  it("rejects construction with a non-positive stale threshold", () => {
    expect(() => new GameActivityTracker({ staleAfterMs: 0 })).toThrow();
  });
});

describe("formatGameActivityMessage", () => {
  it("returns null when nobody is playing", () => {
    expect(
      formatGameActivityMessage({
        collectedAt: 1,
        entries: [],
        totalPlayers: 0,
      }),
    ).toBeNull();
  });

  it("renders one line per game with player count and mentions", () => {
    const formatted = formatGameActivityMessage({
      collectedAt: 1,
      entries: [
        { gameName: "Apex Legends", userIds: new Set(["alice", "bob"]) },
        { gameName: "VALORANT", userIds: new Set(["carol"]) },
      ],
      totalPlayers: 3,
    });

    expect(formatted).toBe(
      [
        "🎮 現在プレイ中: 3人",
        "- **Apex Legends**: 2人 playing (<@alice>, <@bob>)",
        "- **VALORANT**: 1人 playing (<@carol>)",
      ].join("\n"),
    );
  });

  it("summarizes the snapshot for short responses", () => {
    const summary = summarizeGameActivity({
      collectedAt: 1,
      entries: [
        { gameName: "Apex Legends", userIds: new Set(["alice", "bob"]) },
        { gameName: "VALORANT", userIds: new Set(["carol"]) },
      ],
      totalPlayers: 3,
    });

    expect(summary).toBe("Apex Legends: 2人 / VALORANT: 1人");
  });
});

type FakeChannel = GameActivityMessageTarget & {
  sentPayloads: { content: string }[];
};

function createFakeChannel(): FakeChannel {
  const channel: FakeChannel = {
    sentPayloads: [],
    send: vi.fn(),
  } as unknown as FakeChannel;
  channel.send = vi.fn(async (payload: { content: string }) => {
    channel.sentPayloads.push(payload);
    return {
      id: `msg-${channel.sentPayloads.length}`,
      edit: vi.fn(async () => undefined),
    };
  });
  return channel;
}

describe("createGameActivityHandler", () => {
  it("is a no-op when the feature is not configured", async () => {
    const resolveChannel = vi.fn();
    const handler = createGameActivityHandler(
      { ...defaultConfig },
      {
        resolveChannel,
        now: () => 1_000,
      },
    );

    await handler.handlePresenceUpdate({
      userId: "alice",
      activities: [{ name: "Apex Legends", type: 0 }],
    });

    expect(resolveChannel).not.toHaveBeenCalled();
    expect(handler.snapshot().entries).toHaveLength(0);
  });

  it("posts a summary message when a whitelisted game appears", async () => {
    const channel = createFakeChannel();
    const resolveChannel = vi.fn(async () => channel);
    const handler = createGameActivityHandler(baseConfig, {
      resolveChannel,
      now: () => 5_000,
    });

    await handler.handlePresenceUpdate({
      userId: "alice",
      activities: [{ name: "Apex Legends", type: 0 }],
    });

    expect(resolveChannel).toHaveBeenCalledWith("channel-1");
    expect(channel.sentPayloads).toHaveLength(1);
    expect(channel.sentPayloads[0]?.content).toContain("Apex Legends");
    expect(channel.sentPayloads[0]?.content).toContain("1人 playing");
  });

  it("removes the user when a non-whitelisted activity is reported", async () => {
    const channel = createFakeChannel();
    const handler = createGameActivityHandler(baseConfig, {
      resolveChannel: async () => channel,
      now: () => 5_000,
    });

    await handler.handlePresenceUpdate({
      userId: "alice",
      activities: [{ name: "Apex Legends", type: 0 }],
    });
    await handler.handlePresenceUpdate({
      userId: "alice",
      activities: [{ name: "Stardew Valley", type: 0 }],
    });

    const snapshot = handler.snapshot();
    expect(snapshot.entries).toHaveLength(0);
  });

  it("drops stale entries on refresh", async () => {
    const channel = createFakeChannel();
    let now = 0;
    const handler = createGameActivityHandler(baseConfig, {
      resolveChannel: async () => channel,
      now: () => now,
    });

    await handler.handlePresenceUpdate({
      userId: "alice",
      activities: [{ name: "Apex Legends", type: 0 }],
    });

    now = 10 * 60_000; // 10 minutes later — past the 5 minute stale threshold
    await handler.render();

    expect(handler.snapshot().entries).toHaveLength(0);
  });

  it("skips posting when no observers and no eviction happened", async () => {
    const channel = createFakeChannel();
    const now = (): number => 0;
    const handler = createGameActivityHandler(baseConfig, {
      resolveChannel: async () => channel,
      now,
    });

    await handler.render();

    expect(channel.sentPayloads).toHaveLength(0);
  });

  it("clears the message id after posting an empty placeholder", async () => {
    const channel = createFakeChannel();
    let now = 0;
    const handler = createGameActivityHandler(baseConfig, {
      resolveChannel: async () => channel,
      now: () => now,
    });

    await handler.handlePresenceUpdate({
      userId: "alice",
      activities: [{ name: "Apex Legends", type: 0 }],
    });
    expect(channel.sentPayloads).toHaveLength(1);

    now = 10 * 60_000;
    await handler.render();

    // The handler posts a "no active players" placeholder so the next
    // observation does not pile up against a stale message id.
    expect(channel.sentPayloads.length).toBeGreaterThanOrEqual(2);
    expect(channel.sentPayloads.at(-1)?.content).toContain("ありません");
  });
});

import { ActivityType } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  createSpotifyNowPlayingHandler,
  type PresenceUpdateInput,
} from "../src/features/spotify/handler.js";
import { NowPlayingStore } from "../src/features/spotify/state.js";

function spotifyActivity(overrides: Partial<{ title: string; artist: string; trackId: string }> = {}) {
  return {
    type: ActivityType.Listening,
    name: "Spotify",
    details: overrides.title ?? "Never Gonna Give You Up",
    state: overrides.artist ?? "Rick Astley",
    syncId: overrides.trackId ?? "track-1",
    assets: null,
    timestamps: { start: 1_700_000_000_000, end: 1_700_000_180_000 },
  };
}

function presence(overrides: Partial<PresenceUpdateInput> = {}): PresenceUpdateInput {
  return {
    userId: "user-1",
    guildId: "guild-1",
    displayName: "alice",
    activities: [spotifyActivity()],
    ...overrides,
  };
}

describe("spotify now-playing handler", () => {
  it("starts a new entry and sends an embed when Spotify is detected", async () => {
    const sendEmbed = vi.fn(async () => "msg-1");
    const editEmbed = vi.fn();
    const deleteEmbed = vi.fn();
    const store = new NowPlayingStore(60_000);
    const handler = createSpotifyNowPlayingHandler({
      store,
      sendEmbed,
      editEmbed,
      deleteEmbed,
    });

    const result = await handler.onPresenceUpdate(presence());

    expect(result.kind).toBe("started");
    if (result.kind !== "started") return;
    expect(result.entry.userId).toBe("user-1");
    expect(result.entry.embedMessageId).toBe("msg-1");
    expect(result.entry.track.title).toBe("Never Gonna Give You Up");
    expect(sendEmbed).toHaveBeenCalledTimes(1);
    expect(editEmbed).not.toHaveBeenCalled();
    expect(deleteEmbed).not.toHaveBeenCalled();
    expect(store.get("user-1")?.embedMessageId).toBe("msg-1");
  });

  it("refreshes the entry timestamp when the same track is reported again", async () => {
    const sendEmbed = vi.fn(async () => "msg-1");
    const editEmbed = vi.fn(async () => undefined);
    const deleteEmbed = vi.fn();
    const store = new NowPlayingStore(60_000);
    let currentTime = 1_000;
    const handler = createSpotifyNowPlayingHandler({
      store,
      sendEmbed,
      editEmbed,
      deleteEmbed,
      now: () => currentTime,
    });

    await handler.onPresenceUpdate(presence());
    currentTime = 5_000;
    const result = await handler.onPresenceUpdate(presence());

    expect(result.kind).toBe("updated");
    expect(editEmbed).not.toHaveBeenCalled();
    expect(sendEmbed).toHaveBeenCalledTimes(1);
    expect(store.get("user-1")?.lastUpdatedAt).toBe(5_000);
  });

  it("removes the entry and deletes the embed when Spotify stops", async () => {
    const sendEmbed = vi.fn(async () => "msg-1");
    const editEmbed = vi.fn();
    const deleteEmbed = vi.fn(async () => undefined);
    const store = new NowPlayingStore(60_000);
    const handler = createSpotifyNowPlayingHandler({
      store,
      sendEmbed,
      editEmbed,
      deleteEmbed,
    });

    await handler.onPresenceUpdate(presence());
    const result = await handler.onPresenceUpdate(
      presence({ activities: [{ type: ActivityType.Playing, name: "VS Code" }] }),
    );

    expect(result.kind).toBe("removed");
    if (result.kind !== "removed") return;
    expect(result.reason).toBe("ended");
    expect(deleteEmbed).toHaveBeenCalledWith("user-1", "msg-1");
    expect(store.get("user-1")).toBeUndefined();
  });

  it("returns none when there is no Spotify activity and no prior entry", async () => {
    const sendEmbed = vi.fn();
    const editEmbed = vi.fn();
    const deleteEmbed = vi.fn();
    const store = new NowPlayingStore(60_000);
    const handler = createSpotifyNowPlayingHandler({
      store,
      sendEmbed,
      editEmbed,
      deleteEmbed,
    });

    const result = await handler.onPresenceUpdate(
      presence({ activities: [{ type: ActivityType.Watching, name: "YouTube" }] }),
    );

    expect(result.kind).toBe("none");
    expect(sendEmbed).not.toHaveBeenCalled();
    expect(deleteEmbed).not.toHaveBeenCalled();
  });

  it("does not crash when sendEmbed is missing and falls back to a null message id", async () => {
    const store = new NowPlayingStore(60_000);
    const handler = createSpotifyNowPlayingHandler({ store });
    const result = await handler.onPresenceUpdate(presence());
    expect(result.kind).toBe("started");
    if (result.kind !== "started") return;
    expect(result.entry.embedMessageId).toBeNull();
  });

  it("falls back to sendEmbed when editEmbed throws", async () => {
    const sendEmbed = vi.fn(async () => "msg-2");
    const editEmbed = vi.fn(async () => {
      throw new Error("message gone");
    });
    const store = new NowPlayingStore(60_000);
    const handler = createSpotifyNowPlayingHandler({
      store,
      sendEmbed,
      editEmbed,
    });

    await handler.onPresenceUpdate(presence());
    const result = await handler.onPresenceUpdate(
      presence({
        activities: [spotifyActivity({ title: "Together Forever" })],
      }),
    );

    expect(result.kind).toBe("started");
    expect(sendEmbed).toHaveBeenCalledTimes(2);
    expect(store.get("user-1")?.embedMessageId).toBe("msg-2");
  });

  it("prunes stale entries and reports them", async () => {
    const sendEmbed = vi.fn(async () => "msg-1");
    const deleteEmbed = vi.fn(async () => undefined);
    const store = new NowPlayingStore(1_000);
    let currentTime = 1_000;
    const handler = createSpotifyNowPlayingHandler({
      store,
      sendEmbed,
      deleteEmbed,
      now: () => currentTime,
    });

    await handler.onPresenceUpdate(presence());
    currentTime = 5_000;
    const results = await handler.pruneStale();

    expect(results).toHaveLength(1);
    expect(results[0]?.kind).toBe("removed");
    if (results[0]?.kind === "removed") {
      expect(results[0].reason).toBe("stale");
    }
    expect(deleteEmbed).toHaveBeenCalledWith("user-1", "msg-1");
    expect(store.size()).toBe(0);
  });

  it("stopFor clears the entry for a specific user with the requested reason", async () => {
    const sendEmbed = vi.fn(async () => "msg-1");
    const deleteEmbed = vi.fn(async () => undefined);
    const store = new NowPlayingStore(60_000);
    const handler = createSpotifyNowPlayingHandler({
      store,
      sendEmbed,
      deleteEmbed,
    });

    await handler.onPresenceUpdate(presence());
    const result = await handler.stopFor("user-1", "left");

    expect(result?.kind).toBe("removed");
    if (result?.kind !== "removed") return;
    expect(result.reason).toBe("left");
    expect(deleteEmbed).toHaveBeenCalledWith("user-1", "msg-1");
    expect(store.get("user-1")).toBeUndefined();
  });

  it("returns null from stopFor when there is no active entry", async () => {
    const store = new NowPlayingStore(60_000);
    const handler = createSpotifyNowPlayingHandler({ store });
    expect(await handler.stopFor("user-unknown", "ended")).toBeNull();
  });
});
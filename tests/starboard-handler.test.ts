import { describe, expect, it, vi } from "vitest";

import {
  createStarboardHandler,
  type StarboardMessageInfo,
} from "../src/features/starboard/handler.js";

const baseEvent = {
  emoji: { name: "⭐", id: null },
  guildId: "guild-1",
  messageId: "message-1",
  channelId: "channel-1",
};

const baseInfo: StarboardMessageInfo = {
  authorTag: "alice#0001",
  authorAvatarUrl: null,
  content: "Hello, world!",
  reactionCount: 0,
  jumpUrl: "https://discord.com/channels/1/2/3",
  channelName: "general",
  imageUrl: null,
  sourceMessageId: "message-1",
  isAuthorBot: false,
  isNsfw: false,
};

describe("starboard handler", () => {
  it("reposts a message whose star count meets the threshold", async () => {
    const sendRepost = vi.fn(async () => undefined);
    const handler = createStarboardHandler({
      fetchMessageInfo: async () => baseInfo,
      countStarReactions: async () => 5,
      sendRepost,
    });

    await handler.onReactionAdd(baseEvent);

    expect(sendRepost).toHaveBeenCalledTimes(1);
    const call = sendRepost.mock.calls[0] as unknown as [
      string,
      { embeds: { description?: string }[] },
    ];
    const [channelId, payload] = call;
    expect(channelId).toBe("STARBOARD_CHANNEL_ID_PLACEHOLDER");
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0]?.description).toBe("Hello, world!");
    expect(handler.repostedMessageIds.has("message-1")).toBe(true);
  });

  it("does not repost when the count is below the threshold", async () => {
    const sendRepost = vi.fn(async () => undefined);
    const handler = createStarboardHandler({
      fetchMessageInfo: async () => baseInfo,
      countStarReactions: async () => 3,
      sendRepost,
    });

    await handler.onReactionAdd(baseEvent);

    expect(sendRepost).not.toHaveBeenCalled();
    expect(handler.repostedMessageIds.has("message-1")).toBe(false);
  });

  it("does not repost bot-authored messages", async () => {
    const sendRepost = vi.fn(async () => undefined);
    const handler = createStarboardHandler({
      fetchMessageInfo: async () => ({ ...baseInfo, isAuthorBot: true }),
      countStarReactions: async () => 10,
      sendRepost,
    });

    await handler.onReactionAdd(baseEvent);

    expect(sendRepost).not.toHaveBeenCalled();
  });

  it("blocks repost for messages originating in an NSFW channel", async () => {
    const sendRepost = vi.fn(async () => undefined);
    const handler = createStarboardHandler({
      fetchMessageInfo: async () => ({ ...baseInfo, isNsfw: true }),
      countStarReactions: async () => 10,
      sendRepost,
    });

    await handler.onReactionAdd(baseEvent);

    expect(sendRepost).not.toHaveBeenCalled();
  });

  it("ignores reactions with a non-matching emoji", async () => {
    const sendRepost = vi.fn(async () => undefined);
    const fetchMessageInfo = vi.fn(async () => baseInfo);
    const handler = createStarboardHandler({
      fetchMessageInfo,
      countStarReactions: async () => 10,
      sendRepost,
    });

    await handler.onReactionAdd({ ...baseEvent, emoji: { name: "🔥", id: null } });

    expect(fetchMessageInfo).not.toHaveBeenCalled();
    expect(sendRepost).not.toHaveBeenCalled();
  });

  it("only reposts the same message once (idempotency)", async () => {
    const sendRepost = vi.fn(async () => undefined);
    const handler = createStarboardHandler({
      fetchMessageInfo: async () => baseInfo,
      countStarReactions: async () => 6,
      sendRepost,
    });

    await handler.onReactionAdd(baseEvent);
    await handler.onReactionAdd({ ...baseEvent, guildId: "guild-2" });

    expect(sendRepost).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent reaction events for the same messageId to a single repost", async () => {
    // Use a shared deferred so every fetchMessageInfo call resolves together.
    // The chain in the handler ensures only the first run reaches this call;
    // queued runs short-circuit on the repostedMessageIds re-check.
    let resolveFetch: ((info: StarboardMessageInfo) => void) | undefined;
    const fetchPromise = new Promise<StarboardMessageInfo>((resolve) => {
      resolveFetch = resolve;
    });
    // The Promise executor runs synchronously, so resolveFetch is assigned
    // before any code below observes it.
    if (!resolveFetch) {
      throw new Error("resolveFetch should be assigned by the Promise executor");
    }
    const fetchMessageInfo = vi.fn(async () => fetchPromise);
    const sendRepost = vi.fn(async () => undefined);
    const handler = createStarboardHandler({
      fetchMessageInfo,
      countStarReactions: async () => 5,
      sendRepost,
    });

    // Fire three concurrent reaction events for the same messageId. The
    // first call suspends inside fetchMessageInfo; the per-messageId queue
    // holds the other two behind it. With the old check-then-add
    // implementation both would slip past the has() guard and trigger a
    // double repost.
    const first = handler.onReactionAdd(baseEvent);
    const second = handler.onReactionAdd({ ...baseEvent, guildId: "guild-2" });
    const third = handler.onReactionAdd({ ...baseEvent, guildId: "guild-3" });

    // Yield several microtask ticks so the first queued run starts and
    // reaches the await on fetchMessageInfo before we release the deferred.
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
    expect(sendRepost).not.toHaveBeenCalled();
    expect(fetchMessageInfo).toHaveBeenCalledTimes(1);

    // Release the deferred; the first run adds to repostedMessageIds and
    // sends, while the queued runs short-circuit on the re-check.
    resolveFetch(baseInfo);

    await Promise.all([first, second, third]);

    expect(fetchMessageInfo).toHaveBeenCalledTimes(1);
    expect(sendRepost).toHaveBeenCalledTimes(1);
    expect(handler.repostedMessageIds.has("message-1")).toBe(true);
  });

  it("releases the claim when sendRepost fails so a later event can retry", async () => {
    const sendRepost = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(undefined);
    const handler = createStarboardHandler({
      fetchMessageInfo: async () => baseInfo,
      countStarReactions: async () => 5,
      sendRepost,
    });

    await expect(handler.onReactionAdd(baseEvent)).rejects.toThrow("network");
    expect(handler.repostedMessageIds.has("message-1")).toBe(false);

    await handler.onReactionAdd(baseEvent);

    expect(sendRepost).toHaveBeenCalledTimes(2);
    expect(handler.repostedMessageIds.has("message-1")).toBe(true);
  });

  it("skips when the message info cannot be loaded", async () => {
    const sendRepost = vi.fn(async () => undefined);
    const handler = createStarboardHandler({
      fetchMessageInfo: async () => null,
      countStarReactions: async () => 10,
      sendRepost,
    });

    await handler.onReactionAdd(baseEvent);

    expect(sendRepost).not.toHaveBeenCalled();
  });

  it("uses the actual reaction count in the repost payload", async () => {
    const sendRepost = vi.fn(async () => undefined);
    const handler = createStarboardHandler({
      fetchMessageInfo: async () => baseInfo,
      countStarReactions: async () => 9,
      sendRepost,
    });

    await handler.onReactionAdd(baseEvent);

    const call = sendRepost.mock.calls[0] as unknown as [
      string,
      { content: string; embeds: { fields?: { name: string; value: string }[] }[] },
    ];
    const [, payload] = call;
    expect(payload.content).toContain("⭐ 9");
    expect(payload.embeds[0]?.fields?.find((field) => field.name === "Stars")?.value).toBe("⭐ 9");
  });
});

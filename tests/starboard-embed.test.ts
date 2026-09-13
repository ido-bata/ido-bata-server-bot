import { describe, expect, it } from "vitest";

import { buildStarboardPayload } from "../src/features/starboard/embed.js";
import type { StarboardMessageInfo } from "../src/features/starboard/handler.js";

const baseInfo: StarboardMessageInfo = {
  authorTag: "alice#0001",
  authorAvatarUrl: null,
  content: "Hello, world!",
  reactionCount: 7,
  jumpUrl: "https://discord.com/channels/1/2/3",
  channelName: "general",
  imageUrl: null,
  sourceMessageId: "3",
  isAuthorBot: false,
  isNsfw: false,
};

describe("starboard embed", () => {
  it("includes content, author, link, channel and star count in the embed", () => {
    const payload = buildStarboardPayload(baseInfo);

    expect(payload.content).toBe("⭐ 7 — https://discord.com/channels/1/2/3");
    expect(payload.embeds).toHaveLength(1);

    const embed = payload.embeds[0]!;
    expect(embed.description).toBe("Hello, world!");
    expect(embed.author?.name).toBe("alice#0001");
    expect(embed.fields?.map((field) => field.name)).toEqual(["Original", "Channel", "Stars"]);
    expect(embed.fields?.find((field) => field.name === "Stars")?.value).toBe("⭐ 7");
    expect(embed.fields?.find((field) => field.name === "Original")?.value).toContain(
      "https://discord.com/channels/1/2/3",
    );
    expect(embed.fields?.find((field) => field.name === "Channel")?.value).toBe("#general");
  });

  it("falls back to a placeholder when the source message has no text content", () => {
    const payload = buildStarboardPayload({ ...baseInfo, content: "   " });
    expect(payload.embeds[0]?.description).toBe("(no text content)");
  });

  it("attaches an image embed when the source has an image attachment", () => {
    const payload = buildStarboardPayload({
      ...baseInfo,
      imageUrl: "https://cdn.example/image.png",
    });
    expect(payload.embeds[0]?.image?.url).toBe("https://cdn.example/image.png");
  });

  it("attaches a thumbnail for the author avatar when available", () => {
    const payload = buildStarboardPayload({
      ...baseInfo,
      authorAvatarUrl: "https://cdn.example/avatar.png",
    });
    expect(payload.embeds[0]?.author?.icon_url).toBe("https://cdn.example/avatar.png");
    expect(payload.embeds[0]?.thumbnail?.url).toBe("https://cdn.example/avatar.png");
  });

  it("truncates the description to the Discord embed limit", () => {
    const long = "x".repeat(5000);
    const payload = buildStarboardPayload({ ...baseInfo, content: long });
    const description = payload.embeds[0]?.description ?? "";
    expect(description.length).toBeLessThanOrEqual(4096);
    expect(description.endsWith("…")).toBe(true);
  });
});
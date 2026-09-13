import { describe, expect, it } from "vitest";

import {
  isStarboardConfigured,
  matchesStarEmoji,
  starboardConfig,
} from "../src/features/starboard/config.js";

describe("starboard config", () => {
  it("matches the configured unicode star emoji", () => {
    expect(matchesStarEmoji({ name: starboardConfig.emojiName, id: null }, starboardConfig)).toBe(
      true,
    );
  });

  it("does not match a different unicode emoji", () => {
    expect(matchesStarEmoji({ name: "🔥", id: null }, starboardConfig)).toBe(false);
  });

  it("does not match a custom emoji id", () => {
    expect(matchesStarEmoji({ name: "star", id: "123456" }, starboardConfig)).toBe(false);
  });

  it("reports unconfigured state when the channel id is still a placeholder", () => {
    expect(isStarboardConfigured(starboardConfig)).toBe(false);
  });

  it("reports configured state when the channel id is a real value", () => {
    expect(isStarboardConfigured({ ...starboardConfig, channelId: "1234567890" })).toBe(true);
  });
});
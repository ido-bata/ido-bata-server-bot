import { describe, expect, it } from "vitest";

import {
  defaultSpotifyConfig,
  isSpotifyConfigured,
  readSpotifyConfig,
} from "../src/features/spotify/config.js";

describe("spotify config", () => {
  it("default config is disabled and not configured", () => {
    expect(defaultSpotifyConfig.enabled).toBe(false);
    expect(isSpotifyConfigured(defaultSpotifyConfig)).toBe(false);
  });

  it("reads env vars into a typed SpotifyConfig", () => {
    const config = readSpotifyConfig({
      DISCORD_ENABLE_SPOTIFY: "true",
      SPOTIFY_VISIBILITY: "self",
      SPOTIFY_STALE_AFTER_MS: "120000",
    });

    expect(config.enabled).toBe(true);
    expect(config.visibility).toBe("self");
    expect(config.staleAfterMs).toBe(120_000);
  });

  it("falls back to public visibility when env value is invalid", () => {
    const config = readSpotifyConfig({
      DISCORD_ENABLE_SPOTIFY: "true",
      SPOTIFY_VISIBILITY: "garbage",
    });
    expect(config.visibility).toBe("public");
  });

  it("falls back to the default stale threshold when env is missing or invalid", () => {
    expect(
      readSpotifyConfig({ DISCORD_ENABLE_SPOTIFY: "true" }).staleAfterMs,
    ).toBe(5 * 60 * 1000);
    expect(
      readSpotifyConfig({
        DISCORD_ENABLE_SPOTIFY: "true",
        SPOTIFY_STALE_AFTER_MS: "abc",
      }).staleAfterMs,
    ).toBe(5 * 60 * 1000);
    expect(
      readSpotifyConfig({
        DISCORD_ENABLE_SPOTIFY: "true",
        SPOTIFY_STALE_AFTER_MS: "0",
      }).staleAfterMs,
    ).toBe(5 * 60 * 1000);
  });

  it("treats blank channel id as null", () => {
    const config = readSpotifyConfig({
      DISCORD_ENABLE_SPOTIFY: "true",
      SPOTIFY_CHANNEL_ID: "   ",
    });
    expect(config.embedChannelId).toBeNull();
  });

  it("considers public mode configured only when a channel id is set", () => {
    const enabledNoChannel = readSpotifyConfig({ DISCORD_ENABLE_SPOTIFY: "true" });
    expect(isSpotifyConfigured(enabledNoChannel)).toBe(false);

    const enabledWithChannel = readSpotifyConfig({
      DISCORD_ENABLE_SPOTIFY: "true",
      SPOTIFY_CHANNEL_ID: "123",
    });
    expect(isSpotifyConfigured(enabledWithChannel)).toBe(true);
  });

  it("considers self mode configured as soon as enabled", () => {
    const config = readSpotifyConfig({
      DISCORD_ENABLE_SPOTIFY: "true",
      SPOTIFY_VISIBILITY: "self",
    });
    expect(isSpotifyConfigured(config)).toBe(true);
  });
});
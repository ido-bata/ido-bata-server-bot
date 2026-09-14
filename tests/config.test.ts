import { describe, expect, it } from "vitest";

import { readConfig } from "../src/config.js";

describe("readConfig", () => {
  it("returns validated config when required variables are present", () => {
    const config = readConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "guild-id",
    });

    expect(config).toEqual({
      discordToken: "token",
      discordClientId: "client-id",
      discordGuildId: "guild-id",
      enableMessageContentIntent: false,
      voiceConnectionTimeoutMs: 30_000,
    });
  });

  it("enables message content intent only when explicitly configured", () => {
    const config = readConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "guild-id",
      DISCORD_ENABLE_MESSAGE_CONTENT: "true",
    });

    expect(config.enableMessageContentIntent).toBe(true);
  });

  it("uses the voice connection timeout when provided", () => {
    const config = readConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "guild-id",
      VOICE_CONNECTION_TIMEOUT_MS: "5000",
    });

    expect(config.voiceConnectionTimeoutMs).toBe(5_000);
  });

  it("falls back to the default voice connection timeout when unset", () => {
    const config = readConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "guild-id",
    });

    expect(config.voiceConnectionTimeoutMs).toBe(30_000);
  });

  it("throws when a required variable is missing", () => {
    expect(() =>
      readConfig({
        DISCORD_TOKEN: "token",
        DISCORD_CLIENT_ID: "",
      }),
    ).toThrow(/DISCORD_CLIENT_ID/);
  });

  it("rejects a non-numeric voice connection timeout", () => {
    expect(() =>
      readConfig({
        DISCORD_TOKEN: "token",
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_GUILD_ID: "guild-id",
        VOICE_CONNECTION_TIMEOUT_MS: "not-a-number",
      }),
    ).toThrow(/VOICE_CONNECTION_TIMEOUT_MS/);
  });
});

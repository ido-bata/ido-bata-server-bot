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
      enablePresenceIntent: false,
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
    expect(config.enablePresenceIntent).toBe(false);
  });

  it("enables presence intent only when explicitly configured", () => {
    const config = readConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "guild-id",
      DISCORD_ENABLE_PRESENCE_INTENT: "true",
    });

    expect(config.enablePresenceIntent).toBe(true);
    expect(config.enableMessageContentIntent).toBe(false);
  });

  it("throws when a required variable is missing", () => {
    expect(() =>
      readConfig({
        DISCORD_TOKEN: "token",
        DISCORD_CLIENT_ID: "",
      }),
    ).toThrow(/DISCORD_CLIENT_ID/);
  });
});

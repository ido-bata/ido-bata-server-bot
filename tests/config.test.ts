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
      discordGuildIds: ["guild-id"],
      enableMessageContentIntent: false,
      enableGuildMembersIntent: false,
      enablePresenceIntent: false,
      roleAuditChannelId: null,
      logLevel: "info",
      logRingSize: 200,
      tuiMode: "auto",
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

  it("enables guild members intent only when explicitly configured", () => {
    const config = readConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "guild-id",
      DISCORD_ENABLE_GUILD_MEMBERS: "true",
    });

    expect(config.enableGuildMembersIntent).toBe(true);
  });

  it("captures the role audit channel id when provided", () => {
    const config = readConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "guild-id",
      ROLE_AUDIT_CHANNEL_ID: "audit-channel-1",
    });

    expect(config.roleAuditChannelId).toBe("audit-channel-1");
  });

  it("enables presence intent only when explicitly configured", () => {
    const config = readConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "guild-id",
      DISCORD_ENABLE_PRESENCE: "true",
    });

    expect(config.enablePresenceIntent).toBe(true);
  });

  it("parses a comma-separated DISCORD_GUILD_IDS list", () => {
    const config = readConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_IDS: "111, 222,333",
    });

    expect(config.discordGuildIds).toEqual(["111", "222", "333"]);
    expect(config.discordGuildId).toBe("");
  });

  it("unions DISCORD_GUILD_ID and DISCORD_GUILD_IDS without duplicates", () => {
    const config = readConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "111",
      DISCORD_GUILD_IDS: "111,222",
    });

    expect(config.discordGuildIds).toEqual(["111", "222"]);
  });

  it("throws when a required variable is missing", () => {
    expect(() =>
      readConfig({
        DISCORD_TOKEN: "token",
        DISCORD_CLIENT_ID: "",
      }),
    ).toThrow(/DISCORD_CLIENT_ID/);
  });

  it("throws when neither DISCORD_GUILD_ID nor DISCORD_GUILD_IDS is provided", () => {
    expect(() =>
      readConfig({
        DISCORD_TOKEN: "token",
        DISCORD_CLIENT_ID: "client-id",
      }),
    ).toThrow(/guild id/i);
  });

  it("throws when DISCORD_GUILD_ID and DISCORD_GUILD_IDS are both blank", () => {
    expect(() =>
      readConfig({
        DISCORD_TOKEN: "token",
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_GUILD_ID: "   ",
        DISCORD_GUILD_IDS: " , ",
      }),
    ).toThrow(/guild id/i);
  });

  it("defaults logLevel to 'info' and logRingSize to 200", () => {
    const config = readConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "guild-id",
    });
    expect(config.logLevel).toBe("info");
    expect(config.logRingSize).toBe(200);
  });

  it("parses LOG_LEVEL when explicitly provided", () => {
    const config = readConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "guild-id",
      LOG_LEVEL: "debug",
    });
    expect(config.logLevel).toBe("debug");
  });

  it("coerces LOG_RING_SIZE from string and clamps to >=10", () => {
    const config = readConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "guild-id",
      LOG_RING_SIZE: "500",
    });
    expect(config.logRingSize).toBe(500);
  });

  it("rejects LOG_RING_SIZE below 10", () => {
    expect(() =>
      readConfig({
        DISCORD_TOKEN: "token",
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_GUILD_ID: "guild-id",
        LOG_RING_SIZE: "5",
      }),
    ).toThrow();
  });
});

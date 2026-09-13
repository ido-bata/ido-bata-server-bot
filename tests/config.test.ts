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
      roleAuditChannelId: null,
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

  it("captures the role audit channel id when provided", () => {
    const config = readConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "guild-id",
      ROLE_AUDIT_CHANNEL_ID: "audit-channel-1",
    });

    expect(config.roleAuditChannelId).toBe("audit-channel-1");
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
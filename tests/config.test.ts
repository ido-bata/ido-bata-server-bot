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
<<<<<<< HEAD
      enableGuildMembersIntent: false,
=======
      roleAuditChannelId: null,
>>>>>>> 3d7341a (feat(bot): add /role assign and /role remove slash commands)
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

<<<<<<< HEAD
  it("enables guild members intent only when explicitly configured", () => {
=======
  it("captures the role audit channel id when provided", () => {
>>>>>>> 3d7341a (feat(bot): add /role assign and /role remove slash commands)
    const config = readConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "guild-id",
<<<<<<< HEAD
      DISCORD_ENABLE_GUILD_MEMBERS: "true",
    });

    expect(config.enableGuildMembersIntent).toBe(true);
=======
      ROLE_AUDIT_CHANNEL_ID: "audit-channel-1",
    });

    expect(config.roleAuditChannelId).toBe("audit-channel-1");
>>>>>>> 3d7341a (feat(bot): add /role assign and /role remove slash commands)
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
import "dotenv/config";

import { Events } from "discord.js";

import { createDiscordClient } from "./bot/create-discord-client.js";
import { createSlashCommandRegistry } from "./bot/slash-commands.js";
import { readConfig } from "./config.js";
import { registerIcalCalendar } from "./features/ical-calendar/index.js";
import { memberAuditConfig } from "./features/member-audit/config.js";
import { registerMemberAuditHandlers } from "./features/member-audit/handler.js";
import { registerReactionRoleHandlers } from "./features/reaction-roles/handler.js";
import { registerShutdownHandler } from "./features/shutdown/handler.js";
import { registerTimekeeper } from "./features/timekeeper/service.js";

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const client = createDiscordClient({
    enableMessageContentIntent: config.enableMessageContentIntent,
    enableGuildMembersIntent: config.enableGuildMembersIntent,
  });
  const slashCommands = createSlashCommandRegistry();

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
    try {
      await slashCommands.deploy({
        clientId: config.discordClientId,
        guildId: config.discordGuildId,
        token: config.discordToken,
      });
    } catch (error) {
      console.error("Failed to deploy slash commands", error);
    }
  });

  registerReactionRoleHandlers(client);
  registerMemberAuditHandlers(client, {
    config: memberAuditConfig,
    sendMessage: async (channelId, content) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !("send" in channel) || typeof channel.send !== "function") {
        throw new Error(`member-audit: channel ${channelId} is not a text channel`);
      }
      await channel.send(content);
    },
  });
  registerTimekeeper(client);
  registerShutdownHandler(client);
  const icalService = registerIcalCalendar(client, {
    slashCommands,
    onReady: (service) => {
      service.startScheduler();
      void service
        .fetchAndCacheAll()
        .catch((error: unknown) => console.error("[ical-calendar] initial fetch failed", error));
    },
  });

  process.on("beforeExit", () => {
    icalService.stopScheduler();
  });

  await client.login(config.discordToken);
}

main().catch((error: unknown) => {
  console.error("Failed to start Discord bot", error);
  process.exitCode = 1;
});
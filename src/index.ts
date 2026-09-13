import "dotenv/config";

import { Events } from "discord.js";

import { createDiscordClient } from "./bot/create-discord-client.js";
import { readConfig } from "./config.js";
import { memberAuditConfig } from "./features/member-audit/config.js";
import { registerMemberAuditHandlers } from "./features/member-audit/handler.js";
import { registerReactionRoleHandlers } from "./features/reaction-roles/handler.js";
import { registerShutdownHandler } from "./features/shutdown/handler.js";
import { deploySlashCommands } from "./features/slash-commands/deploy.js";
import { registerSlashCommandHandlers } from "./features/slash-commands/handler.js";
import { createSlashCommandRegistry } from "./features/slash-commands/registry.js";
import { registerTimekeeper } from "./features/timekeeper/service.js";

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const client = createDiscordClient({
    enableMessageContentIntent: config.enableMessageContentIntent,
    enableGuildMembersIntent: config.enableGuildMembersIntent,
  });

  const slashRegistry = createSlashCommandRegistry();

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);

    void deploySlashCommands({
      registry: slashRegistry,
      token: config.discordToken,
      clientId: config.discordClientId,
      guildId: config.discordGuildId,
    }).catch((error: unknown) => {
      console.error("Failed to deploy slash commands on ready", error);
    });
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
  registerSlashCommandHandlers(client);
  registerTimekeeper(client);
  registerShutdownHandler(client);

  await client.login(config.discordToken);
}

main().catch((error: unknown) => {
  console.error("Failed to start Discord bot", error);
  process.exitCode = 1;
});

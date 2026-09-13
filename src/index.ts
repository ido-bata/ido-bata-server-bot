import "dotenv/config";

import type { TextChannel } from "discord.js";
import { Events } from "discord.js";

import { createDiscordClient } from "./bot/create-discord-client.js";
import { readConfig } from "./config.js";
import { registerReactionRoleHandlers } from "./features/reaction-roles/handler.js";
import { deployRoleSlashCommands } from "./features/role-slash/deploy.js";
import {
  createRoleSlashCommandRegistry,
} from "./features/role-slash/registry.js";
import { registerRoleSlashHandlers } from "./features/role-slash/handler.js";
import { registerTimekeeper } from "./features/timekeeper/service.js";

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const client = createDiscordClient({
    enableMessageContentIntent: config.enableMessageContentIntent,
  });

  const slashRegistry = createRoleSlashCommandRegistry();

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);

    void deployRoleSlashCommands({
      registry: slashRegistry,
      token: config.discordToken,
      clientId: config.discordClientId,
      guildId: config.discordGuildId,
    }).catch((error: unknown) => {
      console.error("Failed to deploy role slash commands on ready", error);
    });

    // If an audit channel is configured, attempt to log a startup notice so
    // operators know the bot is online. Best-effort — failure here must not
    // crash the bot.
    if (config.roleAuditChannelId) {
      void readyClient.channels
        .fetch(config.roleAuditChannelId)
        .then(async (channel) => {
          if (channel && channel.isTextBased() && "send" in channel) {
            await (channel as TextChannel).send(
              "role slash commands registered (/role assign, /role remove).",
            );
          }
        })
        .catch((error: unknown) => {
          console.warn("Failed to post role-slash startup notice", error);
        });
    }
  });

  registerReactionRoleHandlers(client);
  registerRoleSlashHandlers(client);
  registerTimekeeper(client);

  await client.login(config.discordToken);
}

main().catch((error: unknown) => {
  console.error("Failed to start Discord bot", error);
  process.exitCode = 1;
});
import "dotenv/config";

import { Events } from "discord.js";

import { createDiscordClient } from "./bot/create-discord-client.js";
import { readConfig } from "./config.js";
import { birthdayRoleConfig } from "./features/birthday-role/config.js";
import { deployBirthdayCommands } from "./features/birthday-role/deploy.js";
import { registerBirthdayRoleHandlers } from "./features/birthday-role/service.js";
import { registerReactionRoleHandlers } from "./features/reaction-roles/handler.js";
import { registerTimekeeper } from "./features/timekeeper/service.js";

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const client = createDiscordClient({
    enableMessageContentIntent: config.enableMessageContentIntent,
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
  });

  registerReactionRoleHandlers(client);
  registerTimekeeper(client);
  const birthdayService = registerBirthdayRoleHandlers(client, { config: birthdayRoleConfig });

  client.once(Events.ClientReady, () => {
    void deployBirthdayCommands({
      registry: birthdayService.registry,
      token: config.discordToken,
      clientId: config.discordClientId,
      guildId: config.discordGuildId,
    }).catch((error: unknown) => {
      console.error("Failed to deploy birthday slash commands on ready", error);
    });
  });

  await client.login(config.discordToken);
}

main().catch((error: unknown) => {
  console.error("Failed to start Discord bot", error);
  process.exitCode = 1;
});

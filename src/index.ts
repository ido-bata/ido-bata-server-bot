import "dotenv/config";

import { Events } from "discord.js";

import { createDiscordClient } from "./bot/create-discord-client.js";
import { readConfig } from "./config.js";
import { registerReactionRoleHandlers } from "./features/reaction-roles/handler.js";
import { deployGuildCommands } from "./features/slash-commands/deploy.js";
import { registerSlashCommandHandlers } from "./features/slash-commands/handler.js";
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
  registerSlashCommandHandlers(client);
  registerTimekeeper(client);

  await client.login(config.discordToken);

  // `client.login` resolves once the WebSocket handshake completes; the
  // application id is only guaranteed to be populated after `ClientReady`,
  // so we wait for that before we hit the REST API. Re-deploying on every
  // boot is idempotent (PUT replaces the guild command set wholesale).
  const ready = await new Promise<typeof client>((resolve) => {
    if (client.isReady()) {
      resolve(client);
      return;
    }
    client.once(Events.ClientReady, (readyClient) => {
      resolve(readyClient as typeof client);
    });
  });

  const application = ready.application;

  if (!application) {
    console.warn("Slash commands were not registered: client.application is not yet populated.");
    return;
  }

  try {
    await deployGuildCommands({
      token: config.discordToken,
      applicationId: application.id,
      guildId: config.discordGuildId,
    });
    console.log(`Slash commands registered for guild ${config.discordGuildId}.`);
  } catch (error) {
    console.error("Failed to register slash commands on startup", error);
  }
}

main().catch((error: unknown) => {
  console.error("Failed to start Discord bot", error);
  process.exitCode = 1;
});

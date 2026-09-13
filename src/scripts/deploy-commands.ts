import "dotenv/config";

import { readConfig } from "../config.js";
import { deploySlashCommands } from "../features/slash-commands/deploy.js";
import { createSlashCommandRegistry } from "../features/slash-commands/registry.js";

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const registry = createSlashCommandRegistry();

  const result = await deploySlashCommands({
    registry,
    token: config.discordToken,
    clientId: config.discordClientId,
    guildId: config.discordGuildId,
  });

  console.log(`Deployed ${result.registered} slash command(s) to guild ${config.discordGuildId}.`);
}

main().catch((error: unknown) => {
  console.error("Failed to deploy slash commands", error);
  process.exitCode = 1;
});

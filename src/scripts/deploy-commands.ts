import "dotenv/config";

import { readConfig } from "../config.js";
import { deploySlashCommands } from "../features/slash-commands/deploy.js";
import { createSlashCommandRegistry } from "../features/slash-commands/registry.js";
import { childFor, createRootLogger, getRootLogger } from "../lib/logger/index.js";

async function main(): Promise<void> {
  const config = readConfig(process.env);
  createRootLogger({ ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? "info" });
  const logger = childFor(getRootLogger(), "deploy-commands");

  const registry = createSlashCommandRegistry();

  const result = await deploySlashCommands({
    registry,
    token: config.discordToken,
    clientId: config.discordClientId,
    guildId: config.discordGuildId,
  });

  logger.info(
    { registered: result.registered, guildId: config.discordGuildId },
    "deployed slash commands",
  );
}

main().catch((error: unknown) => {
  childFor(getRootLogger(), "deploy-commands").error(
    { err: error },
    "failed to deploy slash commands",
  );
  process.exitCode = 1;
});

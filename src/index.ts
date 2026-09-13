import "dotenv/config";

import { join } from "node:path";

import { Events } from "discord.js";

import { createDiscordClient } from "./bot/create-discord-client.js";
import { readConfig } from "./config.js";
import { registerReactionRoleHandlers } from "./features/reaction-roles/handler.js";
import { registerConfigHotReload } from "./features/config-hot-reload/register.js";
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

  // `data/config.json` is the runtime-tunable config; see
  // `data/config.example.json` and `src/features/config-hot-reload/`. The
  // store is registered unconditionally so changes propagate live; a missing
  // file at startup logs a warning and starts with an empty snapshot.
  const configStore = registerConfigHotReload({
    filePath: join(process.cwd(), "data", "config.json"),
  });

  const shutdown = () => {
    configStore.stop();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await client.login(config.discordToken);
}

main().catch((error: unknown) => {
  console.error("Failed to start Discord bot", error);
  process.exitCode = 1;
});

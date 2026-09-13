import "dotenv/config";

import { join } from "node:path";

import { Events } from "discord.js";

import { createDiscordClient } from "./bot/create-discord-client.js";
import { readConfig } from "./config.js";
import { registerConfigHotReload } from "./features/config-hot-reload/register.js";
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

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
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

  // `data/config.json` is the runtime-tunable config; see
  // `data/config.example.json` and `src/features/config-hot-reload/`. The
  // store is registered unconditionally so changes propagate live; a missing
  // file at startup logs a warning and starts with an empty snapshot.
  const configStore = registerConfigHotReload({
    filePath: join(process.cwd(), "data", "config.json"),
  });

  // Registering a SIGINT/SIGTERM listener suppresses Node's default exit
  // behavior, so we must tear down the Discord client and terminate the
  // process explicitly — otherwise Ctrl-C / `docker stop` will hang on the
  // live gateway connection.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down`);
    configStore.stop();
    client.destroy();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await client.login(config.discordToken);
}

main().catch((error: unknown) => {
  console.error("Failed to start Discord bot", error);
  process.exitCode = 1;
});
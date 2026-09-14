import "dotenv/config";

import { join } from "node:path";

import type { TextChannel } from "discord.js";
import { Events } from "discord.js";

import { createDiscordClient } from "./bot/create-discord-client.js";
import { readConfig } from "./config.js";
import { birthdayRoleConfig } from "./features/birthday-role/config.js";
import { deployBirthdayCommands } from "./features/birthday-role/deploy.js";
import { registerBirthdayRoleHandlers } from "./features/birthday-role/service.js";
import { registerConfigHotReload } from "./features/config-hot-reload/register.js";
import { registerErrorForwarder } from "./features/error-forwarder/service.js";
import { registerHealthMetrics } from "./features/health-metrics/index.js";
import { memberAuditConfig } from "./features/member-audit/config.js";
import { registerMemberAuditHandlers } from "./features/member-audit/handler.js";
import { messageAuditConfig } from "./features/message-audit/config.js";
import { registerMessageAuditHandlers } from "./features/message-audit/handler.js";
import { deployPollCommands, registerPollHandlers } from "./features/poll/handler.js";
import { registerReactionRoleHandlers } from "./features/reaction-roles/handler.js";
import { registerReminder } from "./features/reminder/service.js";
import { deployRoleSlashCommands } from "./features/role-slash/deploy.js";
import { registerRoleSlashHandlers } from "./features/role-slash/handler.js";
import { createRoleSlashCommandRegistry } from "./features/role-slash/registry.js";
import { registerScheduledAnnouncements } from "./features/scheduled-announcements/service.js";
import { registerShutdownHandler } from "./features/shutdown/handler.js";
import { deploySlashCommands } from "./features/slash-commands/deploy.js";
import { registerSlashCommandHandlers } from "./features/slash-commands/handler.js";
import { createSlashCommandRegistry } from "./features/slash-commands/registry.js";
import { registerStarboardHandlers } from "./features/starboard/handler.js";
import { readSnapshotConfig } from "./features/state-snapshot/config.js";
import {
  createSnapshotRuntime,
  registerStateSnapshotScheduler,
} from "./features/state-snapshot/service.js";
import { registerTimekeeper } from "./features/timekeeper/service.js";
import { registerTimekeeperCommandHandlers } from "./features/timekeeper-commands/handler.js";
import { registerWelcomeHandlers } from "./features/welcome/handler.js";

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const client = createDiscordClient({
    enableMessageContentIntent: config.enableMessageContentIntent,
    enableGuildMembersIntent: config.enableGuildMembersIntent,
  });

  const slashRegistry = createSlashCommandRegistry();
  const roleSlashRegistry = createRoleSlashCommandRegistry();

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
    void deployPollCommands(readyClient, {
      clientId: config.discordClientId,
      guildId: config.discordGuildId,
    }).catch((error: unknown) => {
      console.error("Failed to deploy poll slash commands on ready", error);
    });
    void deployRoleSlashCommands({
      registry: roleSlashRegistry,
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
          if (channel?.isTextBased() && "send" in channel) {
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

  registerErrorForwarder(client);
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
  registerScheduledAnnouncements(client);
  registerMessageAuditHandlers(client, {
    config: messageAuditConfig,
    sendMessage: async (channelId, content) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !("send" in channel) || typeof channel.send !== "function") {
        throw new Error(`message-audit: channel ${channelId} is not a text channel`);
      }
      await channel.send(content);
    },
  });
  registerStarboardHandlers(client);
  registerRoleSlashHandlers(client, {
    roleAuditChannelId: config.roleAuditChannelId,
  });
  registerTimekeeper(client);
  registerTimekeeperCommandHandlers(client);
  registerShutdownHandler(client);
  await registerHealthMetrics(client);
  registerPollHandlers(client);
  registerWelcomeHandlers(client);
  registerReminder(client);

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

  // State snapshots are opt-in. They run when the bot is ready if
  // STATE_SNAPSHOT_ENCRYPTION_KEY is set; otherwise the scheduler no-ops.
  if (process.env.STATE_SNAPSHOT_ENCRYPTION_KEY) {
    const snapshotRuntime = createSnapshotRuntime(readSnapshotConfig(), {
      encryptionKey: process.env.STATE_SNAPSHOT_ENCRYPTION_KEY,
      runOnReady: process.env.STATE_SNAPSHOT_RUN_ON_READY === "true",
    });
    registerStateSnapshotScheduler(client, snapshotRuntime);
  }

  await client.login(config.discordToken);
}

main().catch((error: unknown) => {
  console.error("Failed to start Discord bot", error);
  process.exitCode = 1;
});
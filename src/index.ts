import "dotenv/config";

import { join } from "node:path";
import type { TextChannel } from "discord.js";
import { ChannelType, Events } from "discord.js";

import { createDiscordClient } from "./bot/create-discord-client.js";
import { readConfig } from "./config.js";
import { birthdayRoleConfig } from "./features/birthday-role/config.js";
import { deployBirthdayCommands } from "./features/birthday-role/deploy.js";
import { registerBirthdayRoleHandlers } from "./features/birthday-role/service.js";
import { registerConfigHotReload } from "./features/config-hot-reload/register.js";
import { registerErrorForwarder } from "./features/error-forwarder/service.js";
import { gameActivityConfig } from "./features/game-activity/config.js";
import {
  type GameActivityMessageTarget,
  registerGameActivity,
} from "./features/game-activity/handler.js";
import { registerGitHubWebhook } from "./features/github-webhook/index.js";
import { registerHealthMetrics } from "./features/health-metrics/index.js";
import { registerIcalCalendar } from "./features/ical-calendar/index.js";
import { childFor, createRootLogger, getRootLogger } from "./lib/logger/index.js";
import { memberAuditConfig } from "./features/member-audit/config.js";
import { registerMemberAuditHandlers } from "./features/member-audit/handler.js";
import { messageAuditConfig } from "./features/message-audit/config.js";
import { registerMessageAuditHandlers } from "./features/message-audit/handler.js";
import { bootstrapMultiGuild } from "./features/multi-guild/bootstrap.js";
import { migrateLegacyEnvToGuildConfigs } from "./features/multi-guild/migration.js";
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
import { isSpotifyConfigured, readSpotifyConfig } from "./features/spotify/config.js";
import { registerSpotifyNowPlaying } from "./features/spotify/service.js";
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
  // Initialize the structured logger as the very first side effect so that
  // every subsequent feature registration (and any error thrown during it)
  // emits structured records into the ring buffer / subscribers instead of
  // raw console output. Must happen AFTER `readConfig` so LOG_LEVEL and
  // LOG_RING_SIZE are honored, but BEFORE any feature import side effect.
  createRootLogger(process.env);
  const rootLogger = childFor(getRootLogger(), "composition-root");

  const client = createDiscordClient({
    enableMessageContentIntent: config.enableMessageContentIntent,
    enableGuildMembersIntent: config.enableGuildMembersIntent,
    enablePresenceIntent: config.enablePresenceIntent,
  });
  const slashRegistry = createSlashCommandRegistry();
  const roleSlashRegistry = createRoleSlashCommandRegistry();

  client.once(Events.ClientReady, (readyClient) => {
    rootLogger.info({ tag: readyClient.user.tag }, "discord client ready");

    void deploySlashCommands({
      registry: slashRegistry,
      token: config.discordToken,
      clientId: config.discordClientId,
      guildId: config.discordGuildId,
    }).catch((error: unknown) => {
      rootLogger.error({ err: error }, "failed to deploy slash commands on ready");
    });
    void deployPollCommands(readyClient, {
      clientId: config.discordClientId,
      guildId: config.discordGuildId,
    }).catch((error: unknown) => {
      rootLogger.error({ err: error }, "failed to deploy poll slash commands on ready");
    });
    void deployRoleSlashCommands({
      registry: roleSlashRegistry,
      token: config.discordToken,
      clientId: config.discordClientId,
      guildId: config.discordGuildId,
    }).catch((error: unknown) => {
      rootLogger.error({ err: error }, "failed to deploy role slash commands on ready");
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
          rootLogger.warn({ err: error }, "failed to post role-slash startup notice");
        });
    }
  });

  registerErrorForwarder(client);
  // `registerShutdownHandler` owns the SIGINT/SIGTERM listeners — anything
  // that needs explicit teardown on signal goes through its `onAfterTeardown`
  // hook (see `src/features/shutdown/handler.ts`). The configStore file
  // watcher is wired there so there is exactly one shutdown path.
  const configStore = registerConfigHotReload({
    filePath: join(process.cwd(), "data", "config.json"),
  });
  registerShutdownHandler(
    client,
    {
      onAfterTeardown: () => {
        configStore.stop();
      },
    },
    (message: string) => rootLogger.info(message),
  );
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
      rootLogger.error({ err: error }, "failed to deploy birthday slash commands on ready");
    });
  });

  // State snapshots are opt-in. They run when the bot is ready if
  // STATE_SNAPSHOT_ENCRYPTION_KEY is set; otherwise the scheduler no-ops.
  if (process.env.STATE_SNAPSHOT_ENCRYPTION_KEY) {
    const snapshotRuntime = createSnapshotRuntime(readSnapshotConfig(), {
      encryptionKey: process.env.STATE_SNAPSHOT_ENCRYPTION_KEY,
      runOnReady: process.env.STATE_SNAPSHOT_RUN_ON_READY === "true",
    });
    registerStateSnapshotScheduler(client, snapshotRuntime);
  }

  const spotifyConfig = readSpotifyConfig(process.env);
  if (isSpotifyConfigured(spotifyConfig)) {
    if (!config.enablePresenceIntent) {
      rootLogger.warn(
        "spotify now-playing is configured but DISCORD_ENABLE_PRESENCE=true is required to receive PresenceUpdate events.",
      );
    } else {
      registerSpotifyNowPlaying(client, spotifyConfig);
    }
  }

  registerGameActivity(client, gameActivityConfig, {
    expectedGuildId: config.discordGuildId,
    resolveChannel: async (channelId) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || channel.type === ChannelType.GuildCategory) {
        return null;
      }
      if (!channel.isTextBased() || !("send" in channel) || !("messages" in channel)) {
        return null;
      }
      return {
        send: async (payload) => {
          const message = await channel.send(payload);
          return {
            id: message.id,
            edit: (editPayload) => message.edit(editPayload),
          };
        },
        fetchMessage: async (messageId) => {
          try {
            const message = await channel.messages.fetch(messageId);
            return {
              id: message.id,
              edit: (editPayload) => message.edit(editPayload),
            };
          } catch {
            return null;
          }
        },
        deleteMessage: async (messageId) => {
          try {
            const message = await channel.messages.fetch(messageId);
            await message.delete();
            return true;
          } catch {
            return false;
          }
        },
      } satisfies GameActivityMessageTarget;
    },
  });

  const icalService = registerIcalCalendar(client, {
    onReady: (service) => {
      service.startScheduler();
      void service.fetchAndCacheAll().catch((error: unknown) => {
        rootLogger.error({ err: error }, "ical-calendar initial fetch failed");
      });
    },
  });

  process.on("beforeExit", () => {
    icalService.stopScheduler();
  });

  if (process.env.GITHUB_WEBHOOK_SECRET) {
    try {
      await registerGitHubWebhook(client);
    } catch (error) {
      rootLogger.error({ err: error }, "failed to start GitHub webhook server");
    }
  } else {
    rootLogger.info(
      "GitHub webhook server is disabled (set GITHUB_WEBHOOK_SECRET to enable).",
    );
  }

  // Multi-guild bootstrap is opt-in: set MULTI_GUILD_ENABLE=true to migrate
  // legacy env-based config into per-guild JSON files and mount guild
  // listeners via the registry. Existing single-guild features continue to
  // work without this flag — the registry/feature integration is staged
  // across subsequent PRs.
  if (process.env.MULTI_GUILD_ENABLE === "true") {
    const { store } = bootstrapMultiGuild();
    const migration = await migrateLegacyEnvToGuildConfigs(process.env, store);
    for (const warning of migration.warnings) {
      rootLogger.warn({ warning }, "multi-guild migration warning");
    }
    if (migration.added.length > 0) {
      rootLogger.info(
        { added: migration.added },
        "multi-guild migration: added guild configs",
      );
    }
  }

  await client.login(config.discordToken);
}

main().catch((error: unknown) => {
  childFor(getRootLogger(), "composition-root").error(
    { err: error },
    "failed to start Discord bot",
  );
  process.exitCode = 1;
});

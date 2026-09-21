import "dotenv/config";

import { join } from "node:path";
import type { TextChannel } from "discord.js";
import { ChannelType, Events } from "discord.js";

import { createDiscordClient } from "./bot/create-discord-client.js";
import { readConfig } from "./config.js";
import type { ConsentConfig } from "./consent/config.js";
import { createConsentLogger } from "./consent/logger.js";
import { createReactionHandler } from "./consent/reaction-handler.js";
import { reconcileConsentsOnReady } from "./consent/reconciliation.js";
import { createJsonConsentRepository } from "./consent/repository-json.js";
import type { ConsentScope } from "./consent/scopes.js";
import type { ConsentService } from "./consent/service.js";
import { createConsentService } from "./consent/service.js";
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
import { memberAuditConfig } from "./features/member-audit/config.js";
import { registerMemberAuditHandlers } from "./features/member-audit/handler.js";
import { messageAuditConfig } from "./features/message-audit/config.js";
import { registerMessageAuditHandlers } from "./features/message-audit/handler.js";
import { bootstrapMultiGuild } from "./features/multi-guild/bootstrap.js";
import { migrateLegacyEnvToGuildConfigs } from "./features/multi-guild/migration.js";
import {
  deployPollCommands,
  registerPollHandlers,
  toPollConsentAuthorization,
} from "./features/poll/handler.js";
import { registerReactionRoleHandlers } from "./features/reaction-roles/handler.js";
import { registerReminder, toReminderConsentGate } from "./features/reminder/service.js";
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
  const client = createDiscordClient({
    enableMessageContentIntent: config.enableMessageContentIntent,
    enableGuildMembersIntent: config.enableGuildMembersIntent,
    enablePresenceIntent: config.enablePresenceIntent,
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
  // The privacy subsystem owns a ConsentService reference so it can wire
  // the consent gate into the various consumers below. Created up front
  // so every consumer registration can pass the same instance in.
  let privacyConsentService: ConsentService | null = null;
  if (config.consent.enabled) {
    privacyConsentService = buildConsentService({
      config: config.consent,
    });
    const reactionHandler = createReactionHandler({
      fetcher: {
        async fetchMessageReactions() {
          return new Set<string>();
        },
      },
      service: privacyConsentService,
      targets: buildReactionTargets(config.consent),
      emojiToScope: new Map<string, (typeof config.consent.emojiToScope)[string]>(
        Object.entries(config.consent.emojiToScope),
      ),
      log: createConsentLogger(),
    });
    client.on(Events.MessageReactionAdd, (reaction, user) => {
      const guildId = reaction.message.guildId ?? config.consent.guildId;
      const emojiKey = reaction.emoji.id ?? reaction.emoji.name ?? "";
      if (!guildId || !emojiKey) {
        return;
      }
      void reactionHandler.onAdd(
        reaction.message.id,
        reaction.message.channelId,
        guildId,
        user.id,
        emojiKey,
        Boolean(user.bot),
      );
    });
    client.on(Events.MessageReactionRemove, (reaction, user) => {
      const guildId = reaction.message.guildId ?? config.consent.guildId;
      const emojiKey = reaction.emoji.id ?? reaction.emoji.name ?? "";
      if (!guildId || !emojiKey) {
        return;
      }
      void reactionHandler.onRemove(
        reaction.message.id,
        reaction.message.channelId,
        guildId,
        user.id,
        emojiKey,
        Boolean(user.bot),
      );
    });
    client.once(Events.ClientReady, async () => {
      await reconcileConsentsOnReady({
        client,
        service: privacyConsentService!,
        config: config.consent,
        logger: createConsentLogger(),
      });
    });
  }
  // `registerShutdownHandler` owns the SIGINT/SIGTERM listeners — anything
  // that needs explicit teardown on signal goes through its `onAfterTeardown`
  // hook (see `src/features/shutdown/handler.ts`). The configStore file
  // watcher is wired there so there is exactly one shutdown path.
  const configStore = registerConfigHotReload({
    filePath: join(process.cwd(), "data", "config.json"),
  });
  registerShutdownHandler(client, {
    onAfterTeardown: () => {
      configStore.stop();
    },
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
  registerTimekeeper(client, { consentService: privacyConsentService ?? undefined });
  registerTimekeeperCommandHandlers(client);
  await registerHealthMetrics(client);
  registerPollHandlers(client, {
    consent: privacyConsentService ? toPollConsentAuthorization(privacyConsentService) : undefined,
  });
  registerWelcomeHandlers(client);
  registerReminder(client, {
    consent: privacyConsentService ? toReminderConsentGate(privacyConsentService) : undefined,
  });

  const birthdayService = registerBirthdayRoleHandlers(client, {
    config: birthdayRoleConfig,
    consentService: privacyConsentService ?? undefined,
  });

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

  // State snapshots are opt-in. They run when the bot is ready if
  // STATE_SNAPSHOT_ENCRYPTION_KEY is set; otherwise the scheduler no-ops.
  if (process.env.STATE_SNAPSHOT_ENCRYPTION_KEY) {
    const snapshotRuntime = createSnapshotRuntime(readSnapshotConfig(), {
      encryptionKey: process.env.STATE_SNAPSHOT_ENCRYPTION_KEY,
      runOnReady: process.env.STATE_SNAPSHOT_RUN_ON_READY === "true",
    });
    registerStateSnapshotScheduler(client, snapshotRuntime, {
      consentService: privacyConsentService ?? undefined,
    });
  }

  const spotifyConfig = readSpotifyConfig(process.env);
  if (isSpotifyConfigured(spotifyConfig)) {
    if (!config.enablePresenceIntent) {
      console.warn(
        "Spotify now-playing is configured but DISCORD_ENABLE_PRESENCE=true is required to receive PresenceUpdate events.",
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
      void service
        .fetchAndCacheAll()
        .catch((error: unknown) => console.error("[ical-calendar] initial fetch failed", error));
    },
  });

  process.on("beforeExit", () => {
    icalService.stopScheduler();
  });

  if (process.env.GITHUB_WEBHOOK_SECRET) {
    try {
      await registerGitHubWebhook(client);
    } catch (error) {
      console.error("Failed to start GitHub webhook server", error);
    }
  } else {
    console.log("GitHub webhook server is disabled (set GITHUB_WEBHOOK_SECRET to enable).");
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
      console.warn(`[multi-guild] ${warning}`);
    }
    if (migration.added.length > 0) {
      console.log(`[multi-guild] Migrated guild configs: ${migration.added.join(", ")}`);
    }
  }

  await client.login(config.discordToken);
}

main().catch((error: unknown) => {
  console.error("Failed to start Discord bot", error);
  process.exitCode = 1;
});

/**
 * Build a `ConsentService` from the runtime consent config. Centralized so
 * the composition root in `main()` and the privacy-clear test fixtures stay
 * in lock-step.
 */
function buildConsentService(options: { config: ConsentConfig }): ConsentService {
  const emojiToScope = new Map<string, ConsentScope>(Object.entries(options.config.emojiToScope));
  return createConsentService({
    repository: createJsonConsentRepository({
      filePath: join(process.cwd(), "data", "consent.json"),
    }),
    logger: createConsentLogger(),
    policyVersion: options.config.policyVersion,
    emojiToScope,
  });
}

/**
 * Flatten the consent config into one `ReactionTarget` per configured
 * emoji so the reaction handler can resolve scope without re-parsing the
 * raw env value.
 */
function buildReactionTargets(
  config: ConsentConfig,
): ReadonlyArray<{ channelId: string; emoji: string; guildId: string; messageId: string }> {
  const base = {
    guildId: config.guildId,
    channelId: config.channelId,
    messageId: config.messageId,
  };
  return Object.keys(config.emojiToScope).map((emoji) => ({ ...base, emoji }));
}

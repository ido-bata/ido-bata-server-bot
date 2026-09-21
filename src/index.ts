import "dotenv/config";

import { join } from "node:path";
import type { Client, TextChannel } from "discord.js";
import { ChannelType, Events } from "discord.js";

import { createDiscordClient } from "./bot/create-discord-client.js";
import { readConfig } from "./config.js";
import type { ConsentConfig } from "./consent/config.js";
import { createConsentLogger } from "./consent/logger.js";
import {
  createDiscordReactionFetcher,
  ensureConsentMessage,
} from "./consent/message-bootstrap.js";
import { createReactionHandler } from "./consent/reaction-handler.js";
import { reconcileConsentsOnReady } from "./consent/reconciliation.js";
import { createJsonConsentRepository } from "./consent/repository-json.js";
import type { ConsentScope } from "./consent/scopes.js";
import type { ConsentService } from "./consent/service.js";
import { createConsentService } from "./consent/service.js";
import type { ReactionTarget } from "./consent/types.js";
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
import {
  childFor,
  createRootLogger,
  getRootLogger,
  subscribe as subscribeLogger,
} from "./lib/logger/index.js";
import { createRuntimeStatusStore } from "./runtime/status-store.js";
import { mountTui } from "./tui/render.jsx";

async function main(): Promise<void> {
  const config = readConfig(process.env);
  // Initialize the structured logger as the very first side effect so that
  // every subsequent feature registration (and any error thrown during it)
  // emits structured records into the ring buffer / subscribers instead of
  // raw console output. Must happen AFTER `readConfig` so LOG_LEVEL and
  // LOG_RING_SIZE are honored, but BEFORE any feature import side effect.
  createRootLogger(process.env);
  const rootLogger = childFor(getRootLogger(), "composition-root");

  // Runtime status store. The TUI is a read-only consumer of this store;
  // feature handlers / event listeners below write into it.
  const statusStore = createRuntimeStatusStore();
  statusStore.setEventsCap(config.logRingSize);
  statusStore.set({
    app: {
      ...statusStore.snapshot.app,
      version: process.env.npm_package_version ?? "0.0.0",
    },
    runtime: {
      ...statusStore.snapshot.runtime,
      rssBytes: process.memoryUsage().rss,
    },
  });
  // Push every structured log event into the store's ring buffer so the
  // TUI events panel can tail them.
  subscribeLogger((rec) => {
    statusStore.appendEvent(rec);
  });

  // Mount the TUI early so operator can see boot progress. Returns null
  // when BOT_TUI=off / non-TTY — logger keeps writing JSON Lines in that
  // case.
  const tuiInstance = mountTui(statusStore);

  const client = createDiscordClient({
    enableMessageContentIntent: config.enableMessageContentIntent,
    enableGuildMembersIntent: config.enableGuildMembersIntent,
    enablePresenceIntent: config.enablePresenceIntent,
  });
  const slashRegistry = createSlashCommandRegistry();
  const roleSlashRegistry = createRoleSlashCommandRegistry();

  const botStartedAt = Date.now();

  // Wire Discord lifecycle into the status store so the TUI discord
  // panel reflects connection state, guild count, and gateway ping.
  const refreshDiscord = (): void => {
    const ping = client.ws.ping;
    statusStore.set({
      discord: {
        state: client.isReady() ? "ready" : "connecting",
        user: client.user?.tag ?? null,
        guildCount: client.guilds.cache.size,
        pingMs: Number.isFinite(ping) ? ping : null,
      },
    });
  };
  client.on(Events.ClientReady, refreshDiscord);
  client.on(Events.ShardReady, refreshDiscord);
  client.on(Events.ShardDisconnect, () => {
    statusStore.set({ discord: { ...statusStore.snapshot.discord, state: "disconnected" } });
  });
  client.on(Events.ShardReconnecting, () => {
    statusStore.set({ discord: { ...statusStore.snapshot.discord, state: "connecting" } });
  });

  // Tick RSS / uptime every second so the runtime panel stays fresh even
  // when no log events fire. The timer is cleared on shutdown.
  const metricsTimer = setInterval(() => {
    statusStore.set({
      app: {
        ...statusStore.snapshot.app,
        uptimeMs: Date.now() - botStartedAt,
        capturedAt: Date.now(),
      },
      runtime: {
        ...statusStore.snapshot.runtime,
        rssBytes: process.memoryUsage().rss,
      },
    });
  }, 1000);
  metricsTimer.unref?.();

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
  statusStore.set({
    features: {
      ...statusStore.snapshot.features,
      "error-forwarder": { state: "enabled" },
    },
  });
  // The privacy subsystem owns a ConsentService reference so it can wire
  // the consent gate into the various consumers below. Created up front
  // so every consumer registration can pass the same instance in.
  let privacyConsentService: ConsentService | null = null;
  if (config.consent.enabled) {
    const consentLogger = createConsentLogger();
    const consentTargets: ReactionTarget[] = [];
    privacyConsentService = buildConsentService({
      config: config.consent,
      client,
    });
    const reactionHandler = createReactionHandler({
      fetcher: createDiscordReactionFetcher(client),
      service: privacyConsentService,
      targets: consentTargets,
      emojiToScope: new Map<string, (typeof config.consent.emojiToScope)[string]>(
        Object.entries(config.consent.emojiToScope),
      ),
      log: consentLogger,
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
    client.once(Events.ClientReady, async (readyClient) => {
      try {
        const resolvedConsentConfig = await ensureConsentMessage({
          client: readyClient,
          config: config.consent,
          logger: consentLogger,
        });
        consentTargets.splice(
          0,
          consentTargets.length,
          ...buildReactionTargets(resolvedConsentConfig),
        );
        await reconcileConsentsOnReady({
          client: readyClient,
          service: privacyConsentService!,
          config: resolvedConsentConfig,
          logger: consentLogger,
        });
        statusStore.set({
          features: {
            ...statusStore.snapshot.features,
            consent: {
              state: "enabled",
              meta: {
                messageId: resolvedConsentConfig.messageId,
                policyVersion: resolvedConsentConfig.policyVersion,
              },
            },
          },
        });
      } catch (error) {
        rootLogger.error({ err: error }, "failed to bootstrap consent message");
        statusStore.set({
          features: {
            ...statusStore.snapshot.features,
            consent: { state: "degraded", meta: { reason: "bootstrap-failed" } },
          },
        });
      }
    });
  }
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
      onAfterTeardown: async () => {
        clearInterval(metricsTimer);
        configStore.stop();
        if (tuiInstance) {
          // Drain pending renders before the process exits so the
          // operator sees the final state instead of a truncated frame.
          await tuiInstance.waitUntilExit().catch(() => undefined);
          return;
        }
        statusStore.clearListeners();
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
  statusStore.set({
    features: {
      ...statusStore.snapshot.features,
      "slash-commands": { state: "enabled" },
    },
  });
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
  registerTimekeeper(client, {
    botConfig: config,
    consentService: privacyConsentService ?? undefined,
  });
  statusStore.set({
    features: {
      ...statusStore.snapshot.features,
      timekeeper: { state: "enabled" },
    },
  });
  registerTimekeeperCommandHandlers(client);
  await registerHealthMetrics(client);
  statusStore.set({
    features: {
      ...statusStore.snapshot.features,
      "health-metrics": { state: "enabled", meta: { port: process.env.HEALTH_METRICS_PORT } },
    },
  });
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
    registerStateSnapshotScheduler(client, snapshotRuntime, {
      consentService: privacyConsentService ?? undefined,
    });
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
  statusStore.set({
    features: {
      ...statusStore.snapshot.features,
      "ical-calendar": { state: "enabled" },
    },
  });

  process.on("beforeExit", () => {
    icalService.stopScheduler();
  });

  if (process.env.GITHUB_WEBHOOK_SECRET) {
    try {
      await registerGitHubWebhook(client);
      statusStore.set({
        features: {
          ...statusStore.snapshot.features,
          "github-webhook": { state: "enabled" },
        },
      });
    } catch (error) {
      rootLogger.error({ err: error }, "failed to start GitHub webhook server");
      statusStore.set({
        features: {
          ...statusStore.snapshot.features,
          "github-webhook": { state: "degraded", meta: { reason: "start-failed" } },
        },
      });
    }
  } else {
    rootLogger.info("GitHub webhook server is disabled (set GITHUB_WEBHOOK_SECRET to enable).");
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
      rootLogger.info({ added: migration.added }, "multi-guild migration: added guild configs");
    }
    statusStore.set({
      features: {
        ...statusStore.snapshot.features,
        "multi-guild": { state: "enabled" },
      },
    });
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

/**
 * Build a `ConsentService` from the runtime consent config. Centralized so
 * the composition root in `main()` and the privacy-clear test fixtures stay
 * in lock-step.
 */
function buildConsentService(options: {
  config: ConsentConfig;
  client: Client;
}): ConsentService {
  const emojiToScope = new Map<string, ConsentScope>(Object.entries(options.config.emojiToScope));
  return createConsentService({
    repository: createJsonConsentRepository({
      filePath: join(process.cwd(), "data", "consent.json"),
    }),
    fetcher: createDiscordReactionFetcher(options.client),
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

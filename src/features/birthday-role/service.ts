// Wires the birthday-role feature into the live Client: registers the slash
// command, schedules the daily JST 0:00 tick, and exposes hooks for the
// `index.ts` entrypoint.

import type { Channel, Client, GuildMember } from "discord.js";
import { ChannelType, Events } from "discord.js";
import type { ConsentService } from "../../consent/service.js";
import { childFor, getRootLogger } from "../../lib/logger/index.js";
import { birthdayCommand, createBirthdayCommandRegistry } from "./commands.js";
import { type BirthdayRoleConfig, birthdayRoleConfig, isBirthdayRoleConfigured } from "./config.js";
import { type JstDate, previousJstDate, toJstDate } from "./date.js";
import {
  type BirthdayConsentAuthorization,
  type BirthdayRoleHandler,
  createBirthdayRoleHandler,
  type HandlerDependencies,
} from "./handler.js";
import { getNextTickAfter } from "./schedule.js";

const logger = childFor(getRootLogger(), "birthday-role");

type ServiceOptions = {
  config?: BirthdayRoleConfig;
  deps?: HandlerDependencies;
  // Lets tests inject a deterministic clock.
  now?: () => Date;
};

export type BirthdayRoleService = {
  handler: BirthdayRoleHandler;
  registry: ReturnType<typeof createBirthdayCommandRegistry>;
};

export function createBirthdayRoleService(options: ServiceOptions = {}): BirthdayRoleService {
  const config = options.config ?? birthdayRoleConfig;
  const handler = createBirthdayRoleHandler({
    config,
    ...(options.deps ?? {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const registry = createBirthdayCommandRegistry();

  return { handler, registry };
}

/**
 * Convert a `ConsentService` into the `BirthdayConsentAuthorization` shape
 * the handler expects. Used by `index.ts` to wire the v0.2.0 consent gate
 * into the live birthday-role handler.
 */
export function toBirthdayConsentAuthorization(
  service: ConsentService,
): BirthdayConsentAuthorization {
  return {
    authorize: async (subjectId, scope) => {
      const decision = await service.authorize(subjectId, scope);
      return { ok: decision.ok };
    },
  };
}

export function registerBirthdayRoleHandlers(
  client: Client,
  options: ServiceOptions & { consentService?: ConsentService } = {},
): BirthdayRoleService {
  const config = options.config ?? birthdayRoleConfig;
  const liveDeps = createLiveHandlerDeps(client, config);
  const consent: BirthdayConsentAuthorization | undefined = options.consentService
    ? toBirthdayConsentAuthorization(options.consentService)
    : options.deps?.consent;
  const deps: HandlerDependencies = {
    config,
    ...liveDeps,
    ...(options.deps ?? {}),
    ...(consent ? { consent } : {}),
  };
  const service = createBirthdayRoleService({ ...options, deps });
  const now = options.now ?? (() => new Date());

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== birthdayCommand.name) return;

    await birthdayCommand.execute(
      {
        interaction,
        commandName: interaction.commandName,
      },
      { handler: service.handler },
    );
  });

  client.once(Events.ClientReady, (readyClient) => {
    if (isBirthdayRoleConfigured(config)) {
      scheduleDailyLoop(readyClient, service, now);
    } else {
      logger.warn(
        "Birthday-role feature is disabled. Set roleId in birthday-role config to enable it.",
      );
    }
  });

  return service;
}

function scheduleDailyLoop(client: Client, service: BirthdayRoleService, now: () => Date): void {
  const tick = getNextTickAfter(now());
  const delayMs = Math.max(0, tick.at.getTime() - now().getTime());

  logger.info(
    { nextTickAt: tick.at.toISOString(), delaySeconds: Math.round(delayMs / 1000) },
    "next birthday-role tick scheduled",
  );

  setTimeout(() => {
    // At JST midnight the wall-clock has just rolled into the new day,
    // so `now()` already yields today's JstDate. We then derive
    // yesterday by subtracting one calendar day (handles month/year
    // rollover via the previousJstDate helper).
    const tickNow = now();
    const today = toJstDate(tickNow);
    const yesterday = previousJstDate(today);

    void runMidnightTick(client, service, yesterday, today).finally(() => {
      scheduleDailyLoop(client, service, now);
    });
  }, delayMs);
}

async function runMidnightTick(
  client: Client,
  service: BirthdayRoleService,
  yesterday: JstDate,
  today: JstDate,
): Promise<void> {
  // Run removal before assignment so any member whose birthday crosses
  // midnight gets re-assigned on the new day without a visible gap.
  try {
    const removed = await service.handler.runRemoveTick(yesterday);
    logger.info({ removed }, "remove tick completed");
  } catch (error: unknown) {
    logger.error({ err: error }, "remove tick failed");
  }

  try {
    const granted = await service.handler.runAssignTick(today);
    logger.info({ granted }, "assign tick completed");
  } catch (error: unknown) {
    logger.error({ err: error }, "assign tick failed");
  }

  void client;
}

// Used by tests to avoid touching the real Discord Client. Production callers
// that want guild-scoped fetches can pre-bind `deps` and pass it in via
// `ServiceOptions.deps`.
export function createLiveHandlerDeps(
  client: Client,
  config: BirthdayRoleConfig,
): Pick<HandlerDependencies, "fetchMember" | "fetchAnnouncementChannel"> {
  return {
    fetchMember: async (userId: string) => {
      const guild = client.guilds.cache.first();
      if (!guild) return null;
      try {
        const member = (await guild.members.fetch(userId)) as GuildMember;
        return {
          id: member.id,
          roles: {
            cache: { has: (roleId: string) => member.roles.cache.has(roleId) },
            add: (roleId: string) => member.roles.add(roleId),
            remove: (roleId: string) => member.roles.remove(roleId),
          },
        };
      } catch {
        return null;
      }
    },
    fetchAnnouncementChannel: async () => {
      if (!config.announcementChannelId) return null;
      const channel = await client.channels.fetch(config.announcementChannelId);
      if (!channel || !isSendable(channel)) return null;
      return {
        send: (content: string) =>
          (channel as unknown as { send: (c: string) => Promise<unknown> }).send(content),
      };
    },
  };
}

function isSendable(channel: Channel): boolean {
  if (channel.type === ChannelType.GuildCategory) return false;
  return typeof (channel as { send?: unknown }).send === "function";
}

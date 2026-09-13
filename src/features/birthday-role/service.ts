// Wires the birthday-role feature into the live Client: registers the slash
// command, schedules the daily JST 0:00 tick, and exposes hooks for the
// `index.ts` entrypoint.

import type { Channel, Client, GuildMember } from "discord.js";
import { ChannelType, Events } from "discord.js";

import {
  birthdayRoleConfig,
  type BirthdayRoleConfig,
  isBirthdayRoleConfigured,
} from "./config.js";
import { birthdayCommand, createBirthdayCommandRegistry } from "./commands.js";
import {
  createBirthdayRoleHandler,
  type BirthdayRoleHandler,
  type HandlerDependencies,
} from "./handler.js";
import { getNextTickAfter } from "./schedule.js";

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

export function registerBirthdayRoleHandlers(
  client: Client,
  options: ServiceOptions = {},
): BirthdayRoleService {
  const config = options.config ?? birthdayRoleConfig;
  const liveDeps = createLiveHandlerDeps(client, config);
  const deps: HandlerDependencies = {
    config,
    ...liveDeps,
    ...(options.deps ?? {}),
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
      console.warn(
        "Birthday-role feature is disabled. Set roleId in birthday-role config to enable it.",
      );
    }
  });

  return service;
}

function scheduleDailyLoop(
  client: Client,
  service: BirthdayRoleService,
  now: () => Date,
): void {
  const tick = getNextTickAfter(now());
  const delayMs = Math.max(0, tick.at.getTime() - now().getTime());

  console.log(
    `[BirthdayRole] Next tick: ${tick.phase} at ${tick.at.toISOString()} (in ${Math.round(
      delayMs / 1000,
    )}s)`,
  );

  setTimeout(() => {
    void safeRun(client, service, "assign").finally(() => {
      scheduleDailyLoop(client, service, now);
    });
  }, delayMs);
}

async function safeRun(
  client: Client,
  service: BirthdayRoleService,
  phase: "assign" | "remove",
): Promise<void> {
  try {
    const result =
      phase === "assign"
        ? await service.handler.runAssignTick()
        : await service.handler.runRemoveTick();

    console.log(`[BirthdayRole] ${phase} tick completed`, result);
    void client;
  } catch (error: unknown) {
    console.error(`[BirthdayRole] ${phase} tick failed`, error);
  }
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

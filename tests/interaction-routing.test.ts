import type { Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { BotConfig } from "../src/config.js";
import type { AnonymousChatService } from "../src/features/anonymous-chat/service.js";
import { birthdayRoleConfig } from "../src/features/birthday-role/config.js";
import { registerBirthdayRoleHandlers } from "../src/features/birthday-role/service.js";
import { createInMemoryBirthdayStorage } from "../src/features/birthday-role/storage.js";
import { bindDiscordCalendarCommands } from "../src/features/ical-calendar/discord.js";
import type { CalendarService } from "../src/features/ical-calendar/service.js";
import { registerPollHandlers } from "../src/features/poll/handler.js";
import { createPollState, type PollStore } from "../src/features/poll/state.js";
import { registerReminder } from "../src/features/reminder/service.js";
import { registerRoleSlashHandlers } from "../src/features/role-slash/handler.js";
import { registerSlashCommandHandlers } from "../src/features/slash-commands/handler.js";
import { registerTimekeeper } from "../src/features/timekeeper/service.js";
import { registerTimekeeperCommandHandlers } from "../src/features/timekeeper-commands/handler.js";

/**
 * Regression coverage for the v0.2.2 `/anon` "unknown command" bug (Issue
 * #115). discord.js fans every InteractionCreate out to ALL registered
 * listeners, so each feature handler must claim only the command names it
 * owns. These tests wire every InteractionCreate handler from `index.ts`
 * onto one fake client and assert that each deployed command produces
 * exactly one user-visible response, with content only its owning handler
 * can produce.
 */

type InteractionListener = (interaction: unknown) => Promise<unknown> | unknown;

type RecordedResponse = {
  method: string;
  options: Record<string, unknown>;
};

function createFakeClient() {
  const listeners: InteractionListener[] = [];
  const guild = {
    id: "guild-1",
    members: {
      fetch: vi.fn(async (userId: string) => ({
        id: userId,
        roles: {
          cache: { has: () => false },
          add: async () => undefined,
          remove: async () => undefined,
        },
      })),
    },
  };
  const client = {
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      if (event === "interactionCreate") {
        listeners.push(listener as InteractionListener);
      }
      return client;
    },
    once: () => client,
    channels: { cache: new Map(), fetch: async () => null },
    guilds: { cache: new Map([[guild.id, guild]]) },
    ws: { ping: 7 },
    user: { tag: "bot#0000" },
    isReady: () => true,
  };
  return { client: client as unknown as Client, listeners };
}

type InteractionSpec = {
  commandName: string;
  subcommand?: string;
  strings?: Record<string, string>;
  roleId?: string;
  guildId?: string | null;
  isChatInputCommand?: boolean;
  isButton?: boolean;
  customId?: string;
};

function createInteraction(client: Client, spec: InteractionSpec, responses: RecordedResponse[]) {
  const record =
    (method: string) =>
    (options: Record<string, unknown> = {}): Promise<Record<string, never>> => {
      responses.push({ method, options });
      return Promise.resolve({});
    };

  const guildId = spec.guildId === undefined ? "guild-1" : spec.guildId;

  return {
    isChatInputCommand: () => spec.isChatInputCommand ?? true,
    isButton: () => spec.isButton ?? false,
    isRepliable: () => true,
    isDeferred: () => false,
    isReplied: () => false,
    commandName: spec.commandName,
    customId: spec.customId ?? "",
    guildId,
    channelId: "channel-1",
    inGuild: () => guildId !== null,
    user: { id: "user-1" },
    memberPermissions: null,
    guild: null,
    channel: { send: async () => ({ id: "poll-message-1" }) },
    client,
    options: {
      getSubcommand: () => spec.subcommand ?? "",
      getString: (name: string) => spec.strings?.[name] ?? null,
      get: () => ({ value: spec.roleId ?? "role-999" }),
    },
    reply: record("reply"),
    editReply: record("editReply"),
    update: record("update"),
    followUp: record("followUp"),
    deferReply: record("deferReply"),
  };
}

// A "visible" response is anything the user can see: a text content, an
// embed, or components. `deferReply` is recorded but never counts —
// it is an acknowledgement, not an answer.
function visibleResponses(responses: RecordedResponse[]): RecordedResponse[] {
  return responses.filter((entry) => {
    const { content, embeds, components } = entry.options;
    return (
      (typeof content === "string" && content.length > 0) ||
      (Array.isArray(embeds) && embeds.length > 0) ||
      (Array.isArray(components) && components.length > 0)
    );
  });
}

function registerAllHandlers() {
  const { client, listeners } = createFakeClient();

  const anonService = {
    post: vi.fn(async () => ({ ok: true as const })),
    auditState: "disabled" as const,
  } satisfies AnonymousChatService;

  const pollStore: PollStore = {
    load: () => createPollState(),
    save: () => undefined,
    path: "memory://polls.json",
  };

  // Mirrors the InteractionCreate registrations in src/index.ts, in the
  // same order. Each register* call adds exactly one listener.
  registerSlashCommandHandlers(client, {
    commandDeps: { anon: { service: anonService }, privacy: {} },
  });
  registerRoleSlashHandlers(client, { roleAuditChannelId: null });
  registerTimekeeper(client, { botConfig: {} as BotConfig });
  registerTimekeeperCommandHandlers(client);
  registerPollHandlers(client, {
    store: pollStore,
    consent: { authorize: async () => ({ ok: true }) },
  });
  registerReminder(client);
  const birthdayConfig = {
    ...birthdayRoleConfig,
    guildId: "guild-1",
    roleId: "role-birthday",
  };
  registerBirthdayRoleHandlers(client, {
    config: birthdayConfig,
    deps: { config: birthdayConfig, storage: createInMemoryBirthdayStorage() },
  });
  bindDiscordCalendarCommands(client, {} as CalendarService).bind();

  return { client, listeners };
}

async function dispatch(
  listeners: InteractionListener[],
  client: Client,
  spec: InteractionSpec,
): Promise<RecordedResponse[]> {
  const responses: RecordedResponse[] = [];
  const interaction = createInteraction(client, spec, responses);

  // discord.js invokes every listener synchronously without awaiting
  // them, so handlers run concurrently. Mirror that: start them all
  // first, then await whatever each returned.
  const pending = listeners.map((listener) => listener(interaction));
  await Promise.all(pending.map((result) => Promise.resolve(result)));

  // Some listeners (e.g. poll) are fire-and-forget: they return before
  // their async handler finishes. Drain the microtask queue so late
  // replies are recorded before assertions run.
  await new Promise((resolve) => setTimeout(resolve, 0));

  return responses;
}

describe("interaction routing across all registered handlers", () => {
  const { client, listeners } = registerAllHandlers();

  it("registers every InteractionCreate handler", () => {
    expect(listeners).toHaveLength(8);
  });

  const cases: Array<{
    commandName: string;
    spec: InteractionSpec;
    ownerName: string;
    expectedContent: string | RegExp;
  }> = [
    {
      commandName: "/anon",
      spec: {
        commandName: "anon",
        strings: { message: "hello anonymously" },
      },
      ownerName: "slash-commands",
      expectedContent: "匿名メッセージを投稿しました。",
    },
    {
      commandName: "/role",
      spec: { commandName: "role", subcommand: "assign", roleId: "role-999" },
      ownerName: "role-slash",
      // role-999 is not slash-assignable in the seeded config, so the
      // owning handler still answers — with the not_assignable message.
      expectedContent: /含まれていません/,
    },
    {
      commandName: "/ping",
      spec: { commandName: "ping" },
      ownerName: "slash-commands",
      expectedContent: "Pong! 7ms",
    },
    {
      commandName: "/privacy",
      spec: { commandName: "privacy", subcommand: "status" },
      ownerName: "slash-commands",
      expectedContent: "Privacy status",
    },
    {
      commandName: "/timekeeper",
      spec: { commandName: "timekeeper", subcommand: "next" },
      ownerName: "timekeeper-commands",
      expectedContent: /次のセッション/,
    },
    {
      commandName: "/poll",
      spec: {
        commandName: "poll",
        subcommand: "create",
        strings: { question: "Lunch?", options: "Yes\nNo" },
      },
      ownerName: "poll",
      expectedContent: "Poll を作成しました。",
    },
    {
      commandName: "/birthday",
      spec: { commandName: "birthday", subcommand: "remove" },
      ownerName: "birthday-role",
      expectedContent: "誕生日は登録されていません。",
    },
    {
      commandName: "/help",
      spec: { commandName: "help" },
      ownerName: "slash-commands",
      expectedContent: "No slash commands are registered yet.",
    },
  ];

  for (const { commandName, spec, ownerName, expectedContent } of cases) {
    it(`${commandName} is answered exactly once by ${ownerName}`, async () => {
      const responses = await dispatch(listeners, client, spec);
      const contents = visibleResponses(responses);

      expect(contents).toHaveLength(1);

      const content = contents[0]?.options.content as string;
      expect(content).not.toContain("unknown command");
      if (expectedContent instanceof RegExp) {
        expect(content).toMatch(expectedContent);
      } else {
        expect(content).toContain(expectedContent);
      }
    });
  }

  it("does not answer a chat-input command no handler owns", async () => {
    const responses = await dispatch(listeners, client, {
      commandName: "definitely-not-a-command",
    });

    // Not even an acknowledgement (deferReply) may be recorded.
    expect(responses).toHaveLength(0);
  });

  it("does not answer non-chat-input interactions", async () => {
    const responses = await dispatch(listeners, client, {
      commandName: "ping",
      isChatInputCommand: false,
    });

    expect(responses).toHaveLength(0);
  });

  it("does not answer button interactions it does not own", async () => {
    const responses = await dispatch(listeners, client, {
      commandName: "",
      isChatInputCommand: false,
      isButton: true,
      customId: "unrelated:component:1",
    });

    expect(responses).toHaveLength(0);
  });
});

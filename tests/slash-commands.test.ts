import { describe, expect, it, vi } from "vitest";

import {
  findSlashCommandDefinition,
  slashCommandDefinitions,
} from "../src/features/slash-commands/config.js";
import { deployGuildCommands } from "../src/features/slash-commands/deploy.js";
import { createSlashCommandHandler } from "../src/features/slash-commands/handler.js";
import {
  buildGuildCommandPayloads,
  guildCommandsRoute,
} from "../src/features/slash-commands/registry.js";

type FakeInteraction = {
  commandName: string;
  client: { ws: { ping: number } };
  reply: ReturnType<typeof vi.fn>;
};

function createFakeInteraction(commandName: string, ping = 42): FakeInteraction {
  return {
    commandName,
    client: { ws: { ping } },
    reply: vi.fn(async () => undefined),
  };
}

describe("slash-commands config", () => {
  it("exposes a non-empty definition list with unique names", () => {
    expect(slashCommandDefinitions.length).toBeGreaterThanOrEqual(2);
    const names = slashCommandDefinitions.map((definition) => definition.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("registers /ping with a description that mentions latency", () => {
    const ping = findSlashCommandDefinition("ping");
    expect(ping).not.toBeNull();
    expect(ping?.description.toLowerCase()).toContain("latency");
  });

  it("registers /help with a description that mentions listing commands", () => {
    const help = findSlashCommandDefinition("help");
    expect(help).not.toBeNull();
    expect(help?.description.toLowerCase()).toContain("slash");
  });

  it("returns null for an unknown command name", () => {
    expect(findSlashCommandDefinition("definitely-not-registered")).toBeNull();
  });
});

describe("slash-commands registry", () => {
  it("renders one payload per definition and includes name + description", () => {
    const payloads = buildGuildCommandPayloads();

    expect(payloads).toHaveLength(slashCommandDefinitions.length);
    for (const payload of payloads) {
      expect(typeof payload.name).toBe("string");
      expect(payload.name.length).toBeGreaterThan(0);
      expect(typeof payload.description).toBe("string");
      expect(payload.description.length).toBeGreaterThan(0);
    }
  });

  it("includes /ping and /help in the rendered payload", () => {
    const names = buildGuildCommandPayloads().map((payload) => payload.name);
    expect(names).toContain("ping");
    expect(names).toContain("help");
  });

  it("builds the guild-scoped REST route for the given application and guild ids", () => {
    const route = guildCommandsRoute("app-123", "guild-456");
    expect(route).toContain("app-123");
    expect(route).toContain("guild-456");
    expect(route).toMatch(/^\/applications\/.+\/guilds\/.+\/commands$/);
  });
});

describe("slash-commands handler", () => {
  it("replies with Pong! <ms> when /ping is invoked", async () => {
    const interaction = createFakeInteraction("ping", 17);
    const handler = createSlashCommandHandler();

    const result = await handler.dispatch(interaction as never);

    expect(result.kind).toBe("replied");
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Pong! 17ms",
      ephemeral: true,
    });
  });

  it("rounds the WebSocket ping value reported to the user", async () => {
    const interaction = createFakeInteraction("ping", 17.6);
    const handler = createSlashCommandHandler();

    await handler.dispatch(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Pong! 18ms",
      ephemeral: true,
    });
  });

  it("uses a deterministic ping source when injected", async () => {
    const interaction = createFakeInteraction("ping", 999);
    const readPing = vi.fn(() => 7);
    const handler = createSlashCommandHandler({ readPing });

    await handler.dispatch(interaction as never);

    expect(readPing).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Pong! 7ms",
      ephemeral: true,
    });
  });

  it("lists every registered command when /help is invoked", async () => {
    const interaction = createFakeInteraction("help");
    const handler = createSlashCommandHandler();

    const result = await handler.dispatch(interaction as never);

    expect(result.kind).toBe("replied");
    const replyArg = interaction.reply.mock.calls[0]?.[0] as {
      content: string;
      ephemeral: boolean;
    };
    expect(replyArg.ephemeral).toBe(true);
    for (const definition of slashCommandDefinitions) {
      expect(replyArg.content).toContain(`\`/${definition.name}\``);
      expect(replyArg.content).toContain(definition.description);
    }
  });

  it("uses the injected help formatter when one is provided", async () => {
    const interaction = createFakeInteraction("help");
    const formatHelp = vi.fn(() => "SENTINEL_HELP_BODY");
    const handler = createSlashCommandHandler({ formatHelp });

    await handler.dispatch(interaction as never);

    expect(formatHelp).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "SENTINEL_HELP_BODY",
      ephemeral: true,
    });
  });

  it("replies with 'unknown command' for an unknown command id", async () => {
    const interaction = createFakeInteraction("not-a-real-command");
    const handler = createSlashCommandHandler();

    const result = await handler.dispatch(interaction as never);

    expect(result.kind).toBe("unknown");
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "unknown command",
      ephemeral: true,
    });
  });

  it("falls back to the injected reply transport", async () => {
    const interaction = createFakeInteraction("ping", 12);
    const reply = vi.fn(async () => undefined);
    const handler = createSlashCommandHandler({ reply });

    await handler.dispatch(interaction as never);

    expect(reply).toHaveBeenCalledWith(interaction, "Pong! 12ms");
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});

describe("slash-commands deploy", () => {
  it("calls the REST PUT entry point with the guild-scoped route and payload", async () => {
    const send = vi.fn(async () => undefined);

    await deployGuildCommands(
      {
        token: "test-token",
        applicationId: "app-123",
        guildId: "guild-456",
      },
      {
        // Use a real REST-shaped stand-in so the default `rest.put(...)`
        // call inside `send` does not blow up, but route everything we
        // want to assert on through the spy.
        createRest: () => ({ put: async () => undefined }) as never,
        send: send as never,
      },
    );

    expect(send).toHaveBeenCalledTimes(1);
    const callArgs = send.mock.calls[0] as unknown as [unknown, `/${string}`, { name: string }[]];
    const [, route, body] = callArgs;
    expect(route).toMatch(/^\/applications\/app-123\/guilds\/guild-456\/commands$/);
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((entry) => entry.name)).toEqual(expect.arrayContaining(["ping", "help"]));
  });

  it("throws a clear error when required identifiers are missing", async () => {
    await expect(
      deployGuildCommands({
        token: "",
        applicationId: "app-123",
        guildId: "guild-456",
      }),
    ).rejects.toThrow(/token/);
  });
});

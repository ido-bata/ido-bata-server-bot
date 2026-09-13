import type { REST } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  deploySlashCommands,
  toApplicationCommandPayload,
} from "../src/features/slash-commands/deploy.js";
import { createSlashCommandHandler } from "../src/features/slash-commands/handler.js";
import { createSlashCommandRegistry } from "../src/features/slash-commands/registry.js";

describe("slash command registry", () => {
  it("exposes the seed ping and help commands", () => {
    const registry = createSlashCommandRegistry();

    expect(registry.definitions.map((definition) => definition.name)).toEqual(["ping", "help"]);
    expect(registry.find("ping")?.name).toBe("ping");
    expect(registry.find("help")?.name).toBe("help");
    expect(registry.find("nope")).toBeUndefined();
  });

  it("produces a Discord-shaped payload for every definition", () => {
    const registry = createSlashCommandRegistry();

    for (const definition of registry.definitions) {
      const payload = toApplicationCommandPayload(definition.buildPayload());

      expect(payload.name).toBe(definition.name);
      expect(payload.description.length).toBeGreaterThan(0);
      expect(payload.description.length).toBeLessThanOrEqual(100);
      expect(payload.type).toBe(1); // CHAT_INPUT
    }
  });
});

describe("slash command handler", () => {
  function createInteractionHarness(commandName: string, wsPing = 12) {
    const reply = vi.fn(async () => undefined);
    const interaction = {
      isChatInputCommand: () => true,
      isRepliable: () => true,
      commandName,
      reply,
      user: { id: "user-1" },
      client: { ws: { ping: wsPing } },
    };

    return { interaction, reply };
  }

  it("routes a /ping interaction to the ping handler", async () => {
    const handler = createSlashCommandHandler();
    const { interaction, reply } = createInteractionHarness("ping", 42);

    await handler.handleInteraction(interaction);

    expect(reply).toHaveBeenCalledWith({
      content: "Pong! 42ms",
      ephemeral: true,
    });
  });

  it("replies with `unknown command` for unknown command names", async () => {
    const handler = createSlashCommandHandler();
    const { interaction, reply } = createInteractionHarness("nope");

    await handler.handleInteraction(interaction);

    expect(reply).toHaveBeenCalledWith({
      content: "unknown command",
      ephemeral: true,
    });
  });

  it("ignores interactions that are not chat-input commands", async () => {
    const handler = createSlashCommandHandler();
    const reply = vi.fn(async () => undefined);
    const interaction = {
      isChatInputCommand: () => false,
      isRepliable: () => true,
      commandName: "ping",
      reply,
      user: { id: "user-1" },
      client: { ws: { ping: 5 } },
    };

    await handler.handleInteraction(interaction);

    expect(reply).not.toHaveBeenCalled();
  });

  it("supports injecting a custom registry of definitions", async () => {
    const customDefinition = {
      name: "echo",
      description: "Echoes the configured prefix.",
      buildPayload: () => ({
        name: "echo",
        description: "Echoes the configured prefix.",
        type: 1 as const,
      }),
      execute: vi.fn(async () => undefined),
    };
    const handler = createSlashCommandHandler({
      registry: createSlashCommandRegistry([customDefinition]),
    });
    const { interaction } = createInteractionHarness("echo");

    await handler.handleInteraction(interaction);

    expect(customDefinition.execute).toHaveBeenCalledWith(
      expect.objectContaining({ commandName: "echo" }),
    );
  });
});

describe("deploySlashCommands", () => {
  function createRestStub() {
    const put = vi.fn(async () => undefined);
    return { rest: { put } as Pick<REST, "put">, put };
  }

  it("PUTs the registry payload to the guild-scoped route", async () => {
    const { rest, put } = createRestStub();
    const registry = createSlashCommandRegistry();

    const result = await deploySlashCommands({
      registry,
      token: "token",
      clientId: "client-1",
      guildId: "guild-1",
      rest,
    });

    expect(put).toHaveBeenCalledTimes(1);
    const [route, options] = put.mock.calls[0] as unknown as [string, { body: unknown[] }];
    expect(route).toBe("/applications/client-1/guilds/guild-1/commands");
    expect(options.body).toHaveLength(registry.definitions.length);
    expect(result).toEqual({ registered: registry.definitions.length });
  });

  it("is idempotent across repeated calls (re-declares the same payload)", async () => {
    const { rest, put } = createRestStub();
    const registry = createSlashCommandRegistry();

    await deploySlashCommands({
      registry,
      token: "token",
      clientId: "client-1",
      guildId: "guild-1",
      rest,
    });
    await deploySlashCommands({
      registry,
      token: "token",
      clientId: "client-1",
      guildId: "guild-1",
      rest,
    });

    expect(put).toHaveBeenCalledTimes(2);
    const firstBody = (put.mock.calls[0] as unknown as [string, { body: unknown[] }])[1].body;
    const secondBody = (put.mock.calls[1] as unknown as [string, { body: unknown[] }])[1].body;
    expect(secondBody).toEqual(firstBody);
  });

  it("rejects missing credentials before calling REST", async () => {
    const { rest, put } = createRestStub();
    const registry = createSlashCommandRegistry();

    await expect(
      deploySlashCommands({
        registry,
        token: "",
        clientId: "client-1",
        guildId: "guild-1",
        rest,
      }),
    ).rejects.toThrow(/token/);
    expect(put).not.toHaveBeenCalled();
  });
});

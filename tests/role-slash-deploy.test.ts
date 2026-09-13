import { describe, expect, it, vi } from "vitest";
import { SlashCommandBuilder } from "discord.js";

import { deployRoleSlashCommands, toApplicationCommandPayload } from "../src/features/role-slash/deploy.js";
import { createRoleSlashCommandRegistry } from "../src/features/role-slash/registry.js";

type PutCall = [(...args: unknown[]) => unknown, { body: unknown[] }];

describe("role-slash deploy", () => {
  it("throws when token is missing", async () => {
    const registry = createRoleSlashCommandRegistry();
    await expect(
      deployRoleSlashCommands({ registry, token: "", clientId: "cid", guildId: "gid" }),
    ).rejects.toThrow(/token/);
  });

  it("throws when clientId is missing", async () => {
    const registry = createRoleSlashCommandRegistry();
    await expect(
      deployRoleSlashCommands({ registry, token: "tok", clientId: "", guildId: "gid" }),
    ).rejects.toThrow(/clientId/);
  });

  it("throws when guildId is missing", async () => {
    const registry = createRoleSlashCommandRegistry();
    await expect(
      deployRoleSlashCommands({ registry, token: "tok", clientId: "cid", guildId: "" }),
    ).rejects.toThrow(/guildId/);
  });

  it("puts the registry payload through the supplied REST", async () => {
    const registry = createRoleSlashCommandRegistry();
    const calls: PutCall[] = [];
    const put = vi.fn(async (...args: unknown[]) => {
      calls.push([args[0] as (...args: unknown[]) => unknown, args[1] as { body: unknown[] }]);
      return undefined;
    });
    const result = await deployRoleSlashCommands({
      registry,
      token: "tok",
      clientId: "cid",
      guildId: "gid",
      rest: { put },
    });

    expect(put).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(1);
    const body = calls[0]?.[1].body;
    expect(Array.isArray(body)).toBe(true);
    expect(result).toEqual({ registered: 1 });
  });

  it("converts SlashCommandBuilder to JSON", () => {
    const builder = new SlashCommandBuilder()
      .setName("test")
      .setDescription("Test command");
    const payload = toApplicationCommandPayload(builder);
    expect(payload.name).toBe("test");
    expect(payload.description).toBe("Test command");
  });

  it("passes through raw payloads unchanged", () => {
    const raw = { name: "raw", description: "raw command" };
    const payload = toApplicationCommandPayload(raw);
    expect(payload).toEqual(raw);
  });
});
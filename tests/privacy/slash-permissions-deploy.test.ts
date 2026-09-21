import type { REST } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { deploySlashCommands } from "../../src/features/slash-commands/deploy.js";
import { createSlashCommandRegistry } from "../../src/features/slash-commands/registry.js";

function createRestStub() {
  const put = vi.fn(async () => undefined);
  return { rest: { put } as Pick<REST, "put">, put };
}

describe("deploySlashCommands — default_member_permissions", () => {
  it("attaches default_member_permissions='0' to `everyone` commands (privacy)", async () => {
    const { rest, put } = createRestStub();
    const registry = createSlashCommandRegistry();

    await deploySlashCommands({
      registry,
      token: "t",
      clientId: "client-1",
      guildId: "guild-1",
      rest,
    });

    const body = (
      put.mock.calls[0] as unknown as [string, { body: Array<Record<string, unknown>> }]
    )[1].body;
    const privacyCommand = body.find((entry) => entry.name === "privacy");
    expect(privacyCommand).toBeDefined();
    expect(privacyCommand?.default_member_permissions).toBe("0");
  });

  it("attaches ManageMessages bit to manage_messages commands (announce)", async () => {
    // The seeded registry has only ping/help/privacy, so build a custom one
    // that exercises every level via the policy table.
    const { rest, put } = createRestStub();
    const registry = createSlashCommandRegistry([
      {
        name: "announce",
        description: "Posts an announcement.",
        buildPayload: () => ({
          name: "announce",
          description: "Posts an announcement.",
          type: 1 as const,
        }),
        execute: () => undefined,
      },
      {
        name: "audit",
        description: "Operator audit.",
        buildPayload: () => ({
          name: "audit",
          description: "Operator audit.",
          type: 1 as const,
        }),
        execute: () => undefined,
      },
      {
        name: "role",
        description: "Self role.",
        buildPayload: () => ({
          name: "role",
          description: "Self role.",
          type: 1 as const,
        }),
        execute: () => undefined,
      },
    ]);

    await deploySlashCommands({
      registry,
      token: "t",
      clientId: "client-1",
      guildId: "guild-1",
      rest,
    });

    const body = (
      put.mock.calls[0] as unknown as [string, { body: Array<Record<string, unknown>> }]
    )[1].body;
    const announce = body.find((entry) => entry.name === "announce");
    const audit = body.find((entry) => entry.name === "audit");
    const role = body.find((entry) => entry.name === "role");
    // ManageMessages bit is 1 << 13 = 8192.
    expect(announce?.default_member_permissions).toBe("8192");
    // Administrator bit is 1 << 3 = 8.
    expect(audit?.default_member_permissions).toBe("8");
    expect(role?.default_member_permissions).toBe("8192");
  });

  it("falls back to manage_messages for commands with no rule", async () => {
    const { rest, put } = createRestStub();
    const registry = createSlashCommandRegistry([
      {
        name: "experimental",
        description: "No rule yet.",
        buildPayload: () => ({
          name: "experimental",
          description: "No rule yet.",
          type: 1 as const,
        }),
        execute: () => undefined,
      },
    ]);

    await deploySlashCommands({
      registry,
      token: "t",
      clientId: "client-1",
      guildId: "guild-1",
      rest,
    });

    const body = (
      put.mock.calls[0] as unknown as [string, { body: Array<Record<string, unknown>> }]
    )[1].body;
    const experimental = body.find((entry) => entry.name === "experimental");
    // DEFAULT_SLASH_PERMISSION_LEVEL is "manage_messages" — the fail-closed
    // default for commands that have no explicit rule.
    expect(experimental?.default_member_permissions).toBe("8192");
  });

  it("hits the /applications/{clientId}/guilds/{guildId}/commands route", async () => {
    const { rest, put } = createRestStub();
    const registry = createSlashCommandRegistry();

    await deploySlashCommands({
      registry,
      token: "t",
      clientId: "client-XYZ",
      guildId: "guild-123",
      rest,
    });

    const [route] = put.mock.calls[0] as unknown as [string, unknown];
    expect(route).toBe("/applications/client-XYZ/guilds/guild-123/commands");
  });
});

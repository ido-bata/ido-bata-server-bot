import { describe, expect, it, vi } from "vitest";

import { createSlashCommandRegistry } from "../src/bot/slash-commands.js";

describe("slash command registry", () => {
  it("registers and lists definitions in insertion order", () => {
    const registry = createSlashCommandRegistry();
    const alpha = { name: "alpha", toJSON: () => ({ name: "alpha", description: "a" }) };
    const beta = { name: "beta", toJSON: () => ({ name: "beta", description: "b" }) };
    registry.register(alpha);
    registry.register(beta);

    expect(registry.list()).toEqual([alpha, beta]);
  });

  it("overwrites a definition when registered under the same name", () => {
    const registry = createSlashCommandRegistry();
    const first = { name: "calendar", toJSON: () => ({ name: "calendar", description: "v1" }) };
    const second = { name: "calendar", toJSON: () => ({ name: "calendar", description: "v2" }) };
    registry.register(first);
    registry.register(second);

    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.toJSON()).toEqual({ name: "calendar", description: "v2" });
  });

  it("deploys definitions via the supplied rest.put implementation", async () => {
    const put = vi.fn(async () => undefined);
    const registry = createSlashCommandRegistry();
    registry.register({
      name: "calendar",
      toJSON: () => ({
        name: "calendar",
        description: "カレンダー連携",
        options: [
          { name: "list", description: "list", type: 1 },
          { name: "show", description: "show", type: 1 },
        ],
      }),
    });

    await registry.deploy({
      clientId: "client-id",
      guildId: "guild-id",
      token: "token",
      rest: { put },
    });

    expect(put).toHaveBeenCalledTimes(1);
    const call = put.mock.calls[0] as unknown as [string, { body: unknown }] | undefined;
    const [path, body] = call ?? [];
    expect(path).toBe("/applications/client-id/guilds/guild-id/commands");
    expect(body).toEqual({
      body: [
        {
          name: "calendar",
          description: "カレンダー連携",
          options: [
            { name: "list", description: "list", type: 1 },
            { name: "show", description: "show", type: 1 },
          ],
        },
      ],
    });
  });
});

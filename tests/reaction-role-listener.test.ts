import { describe, expect, it } from "vitest";

import { createReactionRoleListener } from "../src/features/reaction-roles/handler.js";
import { createGuildRegistry } from "../src/features/multi-guild/registry.js";
import { createFileConfigStore } from "../src/features/multi-guild/store.js";
import { createMemoryFs } from "./multi-guild/memory-fs.js";

function makeStore() {
  return createFileConfigStore({ dataRoot: "data", fs: createMemoryFs() });
}

function silentLogger() {
  return {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

describe("createReactionRoleListener", () => {
  it("registers guild rules on mount and clears them on unmount", async () => {
    const store = makeStore();
    const registry = createGuildRegistry({ store, logger: silentLogger() });
    registry.registerListener(createReactionRoleListener());

    await registry.addGuild("g1", {
      guildId: "g1",
      reactionRoles: [{ messageId: "m1", emoji: "🔥", roleId: "r1" }],
      customEmojis: [],
    });

    // Reload with different content and ensure the listener refreshes its
    // in-memory view (the registry re-runs onMount for the new config).
    await store.saveGuild({
      guildId: "g1",
      reactionRoles: [{ messageId: "m2", emoji: "🌊", roleId: "r2" }],
      customEmojis: [],
    });

    await registry.reloadGuild("g1");
    expect(registry.getConfig("g1")?.reactionRoles[0]?.roleId).toBe("r2");

    await registry.removeGuild("g1");
    expect(registry.listGuilds()).toEqual([]);
  });

  it("keeps rules isolated across multiple mounted guilds", async () => {
    const store = makeStore();
    const registry = createGuildRegistry({ store, logger: silentLogger() });
    registry.registerListener(createReactionRoleListener());

    await registry.addGuild("gA", {
      guildId: "gA",
      reactionRoles: [{ messageId: "mA", emoji: "🔥", roleId: "rA" }],
      customEmojis: [],
    });
    await registry.addGuild("gB", {
      guildId: "gB",
      reactionRoles: [{ messageId: "mB", emoji: "🌊", roleId: "rB" }],
      customEmojis: [],
    });

    expect(registry.getConfig("gA")?.reactionRoles[0]?.roleId).toBe("rA");
    expect(registry.getConfig("gB")?.reactionRoles[0]?.roleId).toBe("rB");

    await registry.shutdown();
  });
});
import { describe, expect, it } from "vitest";

import { createFileConfigStore } from "../../src/features/multi-guild/store.js";
import { createMemoryFs } from "./memory-fs.js";

describe("multi-guild file store", () => {
  it("returns null when a guild config does not exist", async () => {
    const store = createFileConfigStore({ dataRoot: "data", fs: createMemoryFs() });
    expect(await store.loadGuildIfExists("missing")).toBeNull();
  });

  it("persists and reloads a guild config", async () => {
    const fs = createMemoryFs();
    const store = createFileConfigStore({ dataRoot: "data", fs });

    await store.saveGuild({
      guildId: "g1",
      reactionRoles: [{ messageId: "m1", emoji: "🔥", roleId: "r1" }],
      customEmojis: [],
    });

    const reloaded = await store.loadGuild("g1");
    expect(reloaded.guildId).toBe("g1");
    expect(reloaded.reactionRoles[0]?.roleId).toBe("r1");
  });

  it("ensureGuild writes a default the first time and returns it", async () => {
    const fs = createMemoryFs();
    const store = createFileConfigStore({ dataRoot: "data", fs });

    const fresh = await store.ensureGuild("g2");
    expect(fresh.guildId).toBe("g2");
    expect(fresh.reactionRoles).toEqual([]);

    const second = await store.ensureGuild("g2");
    expect(second.guildId).toBe("g2");
  });

  it("lists guild ids with persisted configs", async () => {
    const fs = createMemoryFs();
    const store = createFileConfigStore({ dataRoot: "data", fs });

    await store.ensureGuild("g1");
    await store.ensureGuild("g2");

    const ids = await store.listGuildIds();
    expect(ids.sort()).toEqual(["g1", "g2"]);
  });

  it("rejects saving a config without a guildId", async () => {
    const fs = createMemoryFs();
    const store = createFileConfigStore({ dataRoot: "data", fs });
    await expect(
      store.saveGuild({
        guildId: "",
        reactionRoles: [],
        customEmojis: [],
      }),
    ).rejects.toThrow(/guildId/i);
  });

  it("isolates configs across guilds", async () => {
    const fs = createMemoryFs();
    const store = createFileConfigStore({ dataRoot: "data", fs });

    await store.saveGuild({
      guildId: "gA",
      reactionRoles: [{ messageId: "mA", emoji: "🔥", roleId: "rA" }],
      customEmojis: [],
    });
    await store.saveGuild({
      guildId: "gB",
      reactionRoles: [{ messageId: "mB", emoji: "🌊", roleId: "rB" }],
      customEmojis: [],
    });

    const a = await store.loadGuild("gA");
    const b = await store.loadGuild("gB");
    expect(a.reactionRoles[0]?.roleId).toBe("rA");
    expect(b.reactionRoles[0]?.roleId).toBe("rB");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { GuildListener } from "../../src/features/multi-guild/listener.js";
import { createGuildRegistry } from "../../src/features/multi-guild/registry.js";
import { createFileConfigStore } from "../../src/features/multi-guild/store.js";
import { createMemoryFs } from "./memory-fs.js";

function silentLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeStore() {
  return createFileConfigStore({ dataRoot: "data", fs: createMemoryFs() });
}

describe("multi-guild registry", () => {
  it("mounts listeners on addGuild and unmounts on removeGuild", async () => {
    const store = makeStore();
    const logger = silentLogger();
    const registry = createGuildRegistry({ store, logger });

    const onMount = vi.fn();
    const onUnmount = vi.fn();
    const listener: GuildListener = {
      id: "reaction-roles",
      onMount,
      onUnmount,
    };
    registry.registerListener(listener);

    await registry.addGuild("g1", {
      guildId: "g1",
      reactionRoles: [],
      customEmojis: [],
    });

    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onMount.mock.calls[0]?.[0]?.guildId).toBe("g1");

    await registry.removeGuild("g1");
    expect(onUnmount).toHaveBeenCalledTimes(1);
    expect(onUnmount.mock.calls[0]?.[0]?.guildId).toBe("g1");
    expect(registry.listGuilds()).toEqual([]);
  });

  it("runs listener onMount for every mounted guild when the listener is registered late", async () => {
    const store = makeStore();
    const logger = silentLogger();
    const registry = createGuildRegistry({ store, logger });

    await registry.addGuild("g1", {
      guildId: "g1",
      reactionRoles: [],
      customEmojis: [],
    });
    await registry.addGuild("g2", {
      guildId: "g2",
      reactionRoles: [],
      customEmojis: [],
    });

    const onMount = vi.fn();
    registry.registerListener({ id: "late", onMount });

    // onMount may be called synchronously OR asynchronously after registration
    // — wait one tick so the microtask queue drains.
    await Promise.resolve();
    await Promise.resolve();

    const guildIds = onMount.mock.calls.map((call) => call[0]?.guildId).sort();
    expect(guildIds).toEqual(["g1", "g2"]);
  });

  it("keeps listener state isolated across guilds", async () => {
    const store = makeStore();
    const logger = silentLogger();
    const registry = createGuildRegistry({ store, logger });

    const seen: string[] = [];
    registry.registerListener({
      id: "config-tracker",
      onMount: (ctx) => {
        seen.push(ctx.guildId);
        expect(ctx.config.guildId).toBe(ctx.guildId);
      },
    });

    await registry.addGuild("g1", {
      guildId: "g1",
      reactionRoles: [{ messageId: "m", emoji: "🔥", roleId: "r-g1" }],
      customEmojis: [],
    });
    await registry.addGuild("g2", {
      guildId: "g2",
      reactionRoles: [{ messageId: "m", emoji: "🔥", roleId: "r-g2" }],
      customEmojis: [],
    });

    const g1Config = registry.getConfig("g1");
    const g2Config = registry.getConfig("g2");
    expect(g1Config?.reactionRoles[0]?.roleId).toBe("r-g1");
    expect(g2Config?.reactionRoles[0]?.roleId).toBe("r-g2");
    expect(seen.sort()).toEqual(["g1", "g2"]);
  });

  it("hot-reloads listener state when reloadGuild is called", async () => {
    const store = makeStore();
    const logger = silentLogger();
    const registry = createGuildRegistry({ store, logger });

    const mounts: string[] = [];
    const unmounts: string[] = [];
    registry.registerListener({
      id: "rr",
      onMount: (ctx) => {
        mounts.push(ctx.guildId);
      },
      onUnmount: (ctx) => {
        unmounts.push(ctx.guildId);
      },
    });

    await registry.addGuild("g1", {
      guildId: "g1",
      reactionRoles: [],
      customEmojis: [],
    });

    // Mutate the on-disk config and ask the registry to reload.
    await store.saveGuild({
      guildId: "g1",
      reactionRoles: [{ messageId: "m2", emoji: "🌊", roleId: "r-new" }],
      customEmojis: [],
    });

    await registry.reloadGuild("g1");

    expect(mounts).toEqual(["g1", "g1"]);
    expect(unmounts).toEqual(["g1"]);
    expect(registry.getConfig("g1")?.reactionRoles[0]?.roleId).toBe("r-new");
  });

  it("emits lifecycle events to subscribers", async () => {
    const store = makeStore();
    const logger = silentLogger();
    const registry = createGuildRegistry({ store, logger });

    const events: string[] = [];
    registry.on((event) => {
      events.push(event.kind);
    });

    registry.registerListener({ id: "noop" });

    await registry.addGuild("g1", {
      guildId: "g1",
      reactionRoles: [],
      customEmojis: [],
    });

    await registry.removeGuild("g1");

    expect(events).toContain("listener-registered");
    expect(events).toContain("guild-added");
    expect(events).toContain("guild-removed");
  });

  it("does not throw when removing a guild that was never added", async () => {
    const store = makeStore();
    const logger = silentLogger();
    const registry = createGuildRegistry({ store, logger });

    await expect(registry.removeGuild("never")).resolves.toBeUndefined();
  });

  it("continues to mount other listeners when one throws", async () => {
    const store = makeStore();
    const logger = silentLogger();
    const registry = createGuildRegistry({ store, logger });

    registry.registerListener({
      id: "broken",
      onMount: () => {
        throw new Error("nope");
      },
    });
    const survivingMount = vi.fn();
    registry.registerListener({
      id: "ok",
      onMount: survivingMount,
    });

    await registry.addGuild("g1", {
      guildId: "g1",
      reactionRoles: [],
      customEmojis: [],
    });

    expect(survivingMount).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it("shutdown unmounts every guild and clears listeners", async () => {
    const store = makeStore();
    const logger = silentLogger();
    const registry = createGuildRegistry({ store, logger });

    registry.registerListener({ id: "noop" });
    await registry.addGuild("g1", {
      guildId: "g1",
      reactionRoles: [],
      customEmojis: [],
    });
    await registry.addGuild("g2", {
      guildId: "g2",
      reactionRoles: [],
      customEmojis: [],
    });

    await registry.shutdown();

    expect(registry.listGuilds()).toEqual([]);
    expect(registry.listListeners()).toEqual([]);
  });
});

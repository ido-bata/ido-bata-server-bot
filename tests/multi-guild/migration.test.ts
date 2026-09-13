import { describe, expect, it } from "vitest";

import { migrateLegacyEnvToGuildConfigs } from "../../src/features/multi-guild/migration.js";
import { createFileConfigStore } from "../../src/features/multi-guild/store.js";
import { createMemoryFs } from "./memory-fs.js";

describe("multi-guild env migration", () => {
  it("writes a default config for each id in DISCORD_GUILD_IDS", async () => {
    const fs = createMemoryFs();
    const store = createFileConfigStore({ dataRoot: "data", fs });

    const result = await migrateLegacyEnvToGuildConfigs({ DISCORD_GUILD_IDS: "111,222" }, store);

    expect(result.added.sort()).toEqual(["111", "222"]);
    expect(result.skipped).toEqual([]);

    const one = await store.loadGuild("111");
    expect(one.guildId).toBe("111");
    expect(one.timekeeper).toBeUndefined();
  });

  it("falls back to legacy DISCORD_GUILD_ID when DISCORD_GUILD_IDS is missing", async () => {
    const fs = createMemoryFs();
    const store = createFileConfigStore({ dataRoot: "data", fs });

    const result = await migrateLegacyEnvToGuildConfigs(
      { DISCORD_GUILD_ID: "legacy-guild" },
      store,
    );

    expect(result.added).toEqual(["legacy-guild"]);
    expect(result.warnings.some((w) => w.includes("deprecated"))).toBe(true);
  });

  it("prefers DISCORD_GUILD_IDS over DISCORD_GUILD_ID and warns about both", async () => {
    const fs = createMemoryFs();
    const store = createFileConfigStore({ dataRoot: "data", fs });

    const result = await migrateLegacyEnvToGuildConfigs(
      { DISCORD_GUILD_ID: "old", DISCORD_GUILD_IDS: "new1,new2" },
      store,
    );

    expect(result.added.sort()).toEqual(["new1", "new2"]);
    expect(result.warnings.some((w) => w.includes("takes precedence"))).toBe(true);
  });

  it("skips guilds that already have a config file", async () => {
    const fs = createMemoryFs();
    const store = createFileConfigStore({ dataRoot: "data", fs });
    await store.ensureGuild("existing");

    const result = await migrateLegacyEnvToGuildConfigs(
      { DISCORD_GUILD_IDS: "existing,new" },
      store,
    );

    expect(result.added).toEqual(["new"]);
    expect(result.skipped).toEqual(["existing"]);
  });

  it("seeds timekeeper settings from legacy env variables", async () => {
    const fs = createMemoryFs();
    const store = createFileConfigStore({ dataRoot: "data", fs });

    await migrateLegacyEnvToGuildConfigs(
      {
        DISCORD_GUILD_ID: "tk-guild",
        TIMEKEEPER_TEXT_CHANNEL_ID: "txt",
        TIMEKEEPER_VOICE_CHANNEL_ID: "vc",
        TIMEKEEPER_START_HOUR_JST: "9",
        TIMEKEEPER_START_MINUTE_JST: "30",
      },
      store,
    );

    const config = await store.loadGuild("tk-guild");
    expect(config.timekeeper).toBeDefined();
    expect(config.timekeeper?.textChannelId).toBe("txt");
    expect(config.timekeeper?.voiceChannelId).toBe("vc");
    expect(config.timekeeper?.startHourJst).toBe(9);
    expect(config.timekeeper?.startMinuteJst).toBe(30);
    expect(config.timekeeper?.phases.length).toBeGreaterThan(0);
  });

  it("returns a warning when no guild ids are provided", async () => {
    const fs = createMemoryFs();
    const store = createFileConfigStore({ dataRoot: "data", fs });

    const result = await migrateLegacyEnvToGuildConfigs({}, store);
    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.warnings.some((w) => w.includes("No guild ids"))).toBe(true);
  });

  it("deduplicates guild ids in the input list", async () => {
    const fs = createMemoryFs();
    const store = createFileConfigStore({ dataRoot: "data", fs });

    const result = await migrateLegacyEnvToGuildConfigs({ DISCORD_GUILD_IDS: "g1,g1,g2" }, store);
    expect(result.added.sort()).toEqual(["g1", "g2"]);
  });
});

import { describe, expect, it } from "vitest";

import {
  createDefaultGuildConfig,
  guildConfigSchema,
  parseGuildConfig,
} from "../../src/features/multi-guild/config.js";

describe("multi-guild config schema", () => {
  it("creates a sensible default for a fresh guild", () => {
    const config = createDefaultGuildConfig("123456789");
    expect(config.guildId).toBe("123456789");
    expect(config.reactionRoles).toEqual([]);
    expect(config.customEmojis).toEqual([]);
    expect(config.timekeeper).toBeUndefined();
  });

  it("parses a fully populated guild config", () => {
    const raw = {
      guildId: "123",
      reactionRoles: [{ messageId: "m1", emoji: "🔥", roleId: "r1" }],
      customEmojis: [{ id: "987", name: "fire" }],
      timekeeper: {
        enabled: true,
        startHourJst: 21,
        startMinuteJst: 0,
        textChannelId: "111",
        voiceChannelId: "222",
        phases: [{ label: "Work", durationMinutes: 25 }],
      },
    };
    const parsed = parseGuildConfig(raw);
    expect(parsed.guildId).toBe("123");
    expect(parsed.reactionRoles[0]?.roleId).toBe("r1");
    expect(parsed.timekeeper?.phases[0]?.label).toBe("Work");
  });

  it("rejects configs whose guildId mismatches the path hint", () => {
    expect(() => parseGuildConfig({ guildId: "abc" }, "xyz")).toThrow(/mismatch/i);
  });

  it("rejects configs with invalid reaction role entries", () => {
    const raw = {
      guildId: "1",
      reactionRoles: [{ messageId: "", emoji: "🔥", roleId: "r1" }],
      customEmojis: [],
    };
    expect(() => guildConfigSchema.parse(raw)).toThrow();
  });
});

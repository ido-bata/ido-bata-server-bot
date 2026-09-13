import { describe, expect, it } from "vitest";

import { createGuildRegistry } from "../src/features/multi-guild/registry.js";
import { createFileConfigStore } from "../src/features/multi-guild/store.js";
import { createTimekeeperListener } from "../src/features/timekeeper/service.js";
import { createMemoryFs } from "./multi-guild/memory-fs.js";

function silentLogger() {
  return {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function makeStore() {
  return createFileConfigStore({ dataRoot: "data", fs: createMemoryFs() });
}

describe("createTimekeeperListener", () => {
  it("does nothing for guilds without a timekeeper config", async () => {
    const store = makeStore();
    const registry = createGuildRegistry({ store, logger: silentLogger() });

    // Cast to never because we intentionally pass a stub that satisfies the
    // listener contract (no Discord calls are expected for the no-config path).
    registry.registerListener(createTimekeeperListener({ client: {} as never }));

    await registry.addGuild("g1", {
      guildId: "g1",
      reactionRoles: [],
      customEmojis: [],
    });

    expect(registry.listGuilds()).toEqual(["g1"]);
    await registry.shutdown();
  });

  it("registers state for guilds with a timekeeper config but cancels on unmount", async () => {
    const store = makeStore();
    const registry = createGuildRegistry({ store, logger: silentLogger() });

    // Stub client — no Discord calls happen during the test because we only
    // verify mount/unmount lifecycle, not session playback.
    registry.registerListener(createTimekeeperListener({ client: {} as never }));

    await registry.addGuild("tk", {
      guildId: "tk",
      reactionRoles: [],
      customEmojis: [],
      timekeeper: {
        enabled: true,
        startHourJst: 21,
        startMinuteJst: 0,
        textChannelId: "txt",
        voiceChannelId: "vc",
        phases: [
          { label: "Work", durationMinutes: 25 },
          { label: "Break", durationMinutes: 5 },
          { label: "Work", durationMinutes: 25 },
          { label: "Break", durationMinutes: 5 },
          { label: "Work", durationMinutes: 25 },
        ],
      },
    });

    expect(registry.listGuilds()).toEqual(["tk"]);
    await registry.removeGuild("tk");
    expect(registry.listGuilds()).toEqual([]);
  });
});

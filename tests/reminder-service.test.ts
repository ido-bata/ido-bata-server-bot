import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reminderConfig } from "../src/features/reminder/config.js";
import { createReminderQueue } from "../src/features/reminder/service.js";
import { loadReminders, type LoadOptions, saveReminders } from "../src/features/reminder/store.js";

function makeTempDir(): { options: LoadOptions; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "reminder-service-"));
  const options = { filePath: join(dir, "reminders.json") };
  return {
    options,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeFakeClient(): Client {
  return {
    users: {
      fetch: vi.fn(async () => {
        throw new Error("DM disabled");
      }),
    },
  } as unknown as Client;
}

describe("reminder queue", () => {
  let cleanup: () => void;
  let options: LoadOptions;
  let now: Date;
  let client: Client;

  beforeEach(() => {
    const dir = makeTempDir();
    options = dir.options;
    cleanup = dir.cleanup;
    now = new Date("2030-01-01T00:00:00+09:00");
    client = makeFakeClient();
  });

  afterEach(() => {
    cleanup();
  });

  it("rejects past fire times", () => {
    const queue = createReminderQueue(client, {
      loadOptions: options,
      now: () => now,
    });
    const result = queue.add({
      userId: "u1",
      message: "hi",
      fireAt: new Date(now.getTime() - 1_000),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects durations beyond the configured maximum", () => {
    const queue = createReminderQueue(client, {
      loadOptions: options,
      now: () => now,
    });
    const farFuture = new Date(now.getTime() + reminderConfig.maxDurationMs + 60_000);
    const result = queue.add({ userId: "u1", message: "hi", fireAt: farFuture });
    expect(result.ok).toBe(false);
  });

  it("rejects empty messages", () => {
    const queue = createReminderQueue(client, {
      loadOptions: options,
      now: () => now,
    });
    const result = queue.add({
      userId: "u1",
      message: "   ",
      fireAt: new Date(now.getTime() + 60_000),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects new reminders beyond the per-user limit", () => {
    const queue = createReminderQueue(client, {
      loadOptions: options,
      now: () => now,
    });

    for (let i = 0; i < reminderConfig.maxPerUser; i += 1) {
      const result = queue.add({
        userId: "u1",
        message: `msg-${i}`,
        fireAt: new Date(now.getTime() + 60_000 + i * 1_000),
      });
      expect(result.ok).toBe(true);
    }

    const over = queue.add({
      userId: "u1",
      message: "one too many",
      fireAt: new Date(now.getTime() + 60_000),
    });
    expect(over.ok).toBe(false);
  });

  it("persists reminders through the save hook", () => {
    const queue = createReminderQueue(client, {
      loadOptions: options,
      now: () => now,
    });
    const result = queue.add({
      userId: "u1",
      message: "remember",
      fireAt: new Date(now.getTime() + 60_000),
    });
    expect(result.ok).toBe(true);
    const persisted = loadReminders(options);
    expect(persisted.reminders).toHaveLength(1);
    expect(persisted.reminders[0]?.message).toBe("remember");
  });

  it("loads existing reminders on construction (reload-on-boot pattern)", () => {
    saveReminders(
      [
        {
          id: "preloaded",
          userId: "u1",
          message: "carry over",
          fireAt: new Date(now.getTime() + 60_000).toISOString(),
          createdAt: new Date(now.getTime()).toISOString(),
        },
      ],
      options,
    );

    const queue = createReminderQueue(client, {
      loadOptions: options,
      now: () => now,
    });
    expect(queue.list().map((r) => r.id)).toEqual(["preloaded"]);
  });

  it("dispatches overdue reminders and removes them after success", async () => {
    const openDm = vi.fn(async (userId: string) => ({
      send: async (body: string) => {
        expect(body).toContain("remember");
        return { userId };
      },
    }));
    // Seed the store with a reminder whose fire is already in the past so the
    // very next tick dispatches it.
    saveReminders(
      [
        {
          id: "due-1",
          userId: "u1",
          message: "remember",
          fireAt: new Date(now.getTime() - 5_000).toISOString(),
          createdAt: now.toISOString(),
        },
      ],
      options,
    );

    const queue = createReminderQueue(client, {
      loadOptions: options,
      now: () => now,
      openDm,
    });

    await queue.tick();

    expect(openDm).toHaveBeenCalledWith("u1");
    const persisted = loadReminders(options);
    expect(persisted.reminders).toEqual([]);
  });

  it("keeps reminders when DM delivery fails", async () => {
    const openDm = vi.fn(async () => null);

    // Seed a reminder that is already overdue so the next `tick` picks it
    // up. We bypass `queue.add` here because the production validator
    // refuses past fire times — store-level seeding simulates the
    // reload-after-restart path.
    saveReminders(
      [
        {
          id: "due-1",
          userId: "u1",
          message: "remember",
          fireAt: new Date(now.getTime() - 1_000).toISOString(),
          createdAt: now.toISOString(),
        },
      ],
      options,
    );

    const queue = createReminderQueue(client, {
      loadOptions: options,
      now: () => now,
      openDm,
    });

    await queue.tick();
    const persisted = loadReminders(options);
    expect(persisted.reminders).toHaveLength(1);
  });

  it("keeps cross-user limits independent", () => {
    const queue = createReminderQueue(client, {
      loadOptions: options,
      now: () => now,
    });

    // Fill up user u1
    for (let i = 0; i < reminderConfig.maxPerUser; i += 1) {
      const result = queue.add({
        userId: "u1",
        message: `msg-${i}`,
        fireAt: new Date(now.getTime() + 60_000 + i * 1_000),
      });
      expect(result.ok).toBe(true);
    }
    expect(queue.countForUser("u1")).toBe(reminderConfig.maxPerUser);

    // User u2 should still have headroom
    const result = queue.add({
      userId: "u2",
      message: "fresh",
      fireAt: new Date(now.getTime() + 60_000),
    });
    expect(result.ok).toBe(true);
  });
});

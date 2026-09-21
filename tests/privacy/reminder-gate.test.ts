import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReminderQueue } from "../../src/features/reminder/service.js";
import { type LoadOptions, loadReminders } from "../../src/features/reminder/store.js";

function makeFakeClient(): Client {
  return {
    users: {
      fetch: vi.fn(async () => {
        throw new Error("DM disabled");
      }),
    },
  } as unknown as Client;
}

describe("reminder consent gate", () => {
  let cleanup: () => void;
  let options: LoadOptions;
  let now: Date;
  let client: Client;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "reminder-gate-"));
    options = { filePath: join(dir, "reminders.json") };
    cleanup = () => rmSync(dir, { recursive: true, force: true });
    now = new Date("2030-01-01T00:00:00+09:00");
    client = makeFakeClient();
  });

  afterEach(() => {
    cleanup();
  });

  it("returns ok:false and does not persist when authorize denies", async () => {
    const queue = createReminderQueue(client, {
      consent: { authorize: async () => ({ ok: false }) },
      loadOptions: options,
      now: () => now,
    });
    const result = await queue.add({
      userId: "u1",
      message: "remember",
      fireAt: new Date(now.getTime() + 60_000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("consent denied");
    }
    expect(loadReminders(options).reminders).toEqual([]);
  });

  it("persists when authorize allows", async () => {
    const queue = createReminderQueue(client, {
      consent: { authorize: async () => ({ ok: true }) },
      loadOptions: options,
      now: () => now,
    });
    const result = await queue.add({
      userId: "u1",
      message: "remember",
      fireAt: new Date(now.getTime() + 60_000),
    });
    expect(result.ok).toBe(true);
    expect(loadReminders(options).reminders).toHaveLength(1);
  });

  it("returns 'consent gate not configured' when no gate is wired", async () => {
    const queue = createReminderQueue(client, {
      loadOptions: options,
      now: () => now,
    });
    const result = await queue.add({
      userId: "u1",
      message: "remember",
      fireAt: new Date(now.getTime() + 60_000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("consent gate not configured");
    }
  });
});

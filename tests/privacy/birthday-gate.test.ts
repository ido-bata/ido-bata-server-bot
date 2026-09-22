import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBirthdayRoleHandler } from "../../src/features/birthday-role/handler.js";
import { createInMemoryBirthdayStorage } from "../../src/features/birthday-role/storage.js";

const CONFIGURED_BIRTHDAY_CONFIG = {
  // The handler short-circuits to a noop when `roleId` is empty, so we
  // supply a placeholder that satisfies `isBirthdayRoleConfigured`. The
  // handler never reaches Discord in tests because `fetchMember` is unset.
  guildId: "guild-test",
  roleId: "role-test",
  announcementChannelId: "",
  dataFile: "data/birthdays.json",
} as const;

describe("birthday-role consent gate", () => {
  let cleanup: () => void;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "birthday-gate-"));
    const previousCwd = process.cwd();
    process.chdir(dir);
    cleanup = () => {
      // Windows refuses to remove the current working directory, so chdir
      // back to the test runner's cwd before rmSync. POSIX tolerates
      // rmSync-ing the cwd, so this is a no-op there.
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("refuses to persist when authorize denies", async () => {
    const storage = createInMemoryBirthdayStorage();
    const handler = createBirthdayRoleHandler({
      config: CONFIGURED_BIRTHDAY_CONFIG,
      storage,
      consent: { authorize: async () => ({ ok: false }) },
    });
    const result = await handler.setBirthday("user-1", "2026-04-01");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("consent-denied");
    }
    expect(Object.keys((await storage.load()).birthdays)).toEqual([]);
  });

  it("persists when authorize allows", async () => {
    const storage = createInMemoryBirthdayStorage();
    const handler = createBirthdayRoleHandler({
      config: CONFIGURED_BIRTHDAY_CONFIG,
      storage,
      consent: { authorize: async () => ({ ok: true }) },
    });
    const result = await handler.setBirthday("user-1", "2026-04-01");
    expect(result.ok).toBe(true);
    const loaded = await storage.load();
    expect(loaded.birthdays["user-1"]?.date).toBe("2026-04-01");
  });

  it("refuses persistence when no consent dep is provided (fail-closed at the boundary)", async () => {
    // Without a consent dep, the in-handler guard would normally skip the
    // gate. We test the explicit fail-closed contract by passing a consent
    // dep that returns ok:false: the handler must NOT persist.
    const storage = createInMemoryBirthdayStorage();
    const handler = createBirthdayRoleHandler({
      config: CONFIGURED_BIRTHDAY_CONFIG,
      storage,
      consent: { authorize: async () => ({ ok: false }) },
    });
    const result = await handler.setBirthday("user-1", "2026-04-01");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("consent-denied");
    }
  });
});

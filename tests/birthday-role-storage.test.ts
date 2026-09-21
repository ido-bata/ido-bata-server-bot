import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFileBirthdayStorage,
  createInMemoryBirthdayStorage,
  listBirthdays,
  removeBirthday,
  setBirthday,
} from "../src/features/birthday-role/storage.js";

describe("birthday-role storage", () => {
  it("starts empty", async () => {
    const storage = createInMemoryBirthdayStorage();
    const store = await storage.load();
    expect(store.birthdays).toEqual({});
  });

  it("persists entries through save and load", async () => {
    const storage = createInMemoryBirthdayStorage();
    const baseStore = await storage.load();

    const next = setBirthday(baseStore, "user-1", "1990-04-02", new Date("2026-04-01T00:00:00Z"));
    await storage.save(next);

    const reloaded = await storage.load();
    expect(reloaded.birthdays["user-1"]).toEqual({
      userId: "user-1",
      date: "1990-04-02",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
  });

  it("removes entries", async () => {
    const storage = createInMemoryBirthdayStorage({
      birthdays: {
        "user-1": {
          userId: "user-1",
          date: "1990-04-02",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      },
    });

    const before = await storage.load();
    const after = removeBirthday(before, "user-1");
    await storage.save(after);

    const reloaded = await storage.load();
    expect(reloaded.birthdays).toEqual({});
  });

  it("removeBirthday is a no-op when the user is missing", () => {
    const before = { birthdays: {} };
    const after = removeBirthday(before, "ghost");
    expect(after).toBe(before);
  });

  it("listBirthdays returns every persisted entry", async () => {
    const storage = createInMemoryBirthdayStorage({
      birthdays: {
        a: { userId: "a", date: "1990-04-02", updatedAt: "2026-04-01T00:00:00.000Z" },
        b: { userId: "b", date: "1985-12-31", updatedAt: "2026-04-01T00:00:00.000Z" },
      },
    });

    const entries = listBirthdays(await storage.load());
    expect(entries.map((e) => e.userId).sort()).toEqual(["a", "b"]);
  });
});

describe("file birthday storage — create-on-missing (XVCq)", () => {
  it("creates birthdays.json on the first save so a fresh deployment does not silently drop the registration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "birthday-storage-"));
    const filePath = join(dir, "data", "birthdays.json");
    try {
      // The file MUST NOT exist yet — we are proving the first save
      // materialises it. Otherwise the very first birthday registration
      // after a fresh deploy would acknowledge success but never persist.
      expect(existsSync(filePath)).toBe(false);

      const storage = createFileBirthdayStorage(filePath);
      const baseStore = await storage.load();
      const next = setBirthday(baseStore, "user-1", "1990-04-02", new Date("2026-04-01T00:00:00Z"));
      const saved = await storage.save(next);

      expect(saved.ok).toBe(true);
      if (!saved.ok) throw new Error("birthday save failed unexpectedly");
      expect(saved.mutated).toBe(true);
      expect(existsSync(filePath)).toBe(true);

      // Sanity: the persisted JSON should round-trip back into a usable store.
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as {
        birthdays: Record<string, { userId: string; date: string }>;
      };
      expect(raw.birthdays["user-1"]?.userId).toBe("user-1");
      expect(raw.birthdays["user-1"]?.date).toBe("1990-04-02");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

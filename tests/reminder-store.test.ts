import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type LoadOptions, loadReminders, saveReminders } from "../src/features/reminder/store.js";

function makeLoadOptions(): { options: LoadOptions; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "reminder-store-"));
  const filePath = join(dir, "reminders.json");
  return {
    options: { filePath },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("reminder store", () => {
  it("returns an empty list when the file does not exist", async () => {
    const { options, cleanup } = makeLoadOptions();
    try {
      const result = await loadReminders(options);
      expect(result.reminders).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("round-trips reminders through save -> load", async () => {
    const { options, cleanup } = makeLoadOptions();
    try {
      const reminders = [
        {
          id: "rem-1",
          userId: "user-1",
          message: "check oven",
          fireAt: "2030-01-01T12:00:00+09:00",
          createdAt: "2030-01-01T11:50:00+09:00",
        },
      ];
      await saveReminders(reminders, options);
      const loaded = await loadReminders(options);
      expect(loaded.reminders).toEqual(reminders);
    } finally {
      cleanup();
    }
  });

  it("treats malformed JSON as empty without throwing", async () => {
    const { options, cleanup } = makeLoadOptions();
    const filePath = options.filePath as string;
    try {
      // Pre-write a corrupted file.
      await saveReminders([], { filePath });
      // Now overwrite with garbage using the underlying path.
      writeFileSync(filePath, "{not valid json", "utf8");
      const loaded = await loadReminders(options);
      expect(loaded.reminders).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type LoadOptions,
  loadReminders,
  saveReminders,
} from "../src/features/reminder/store.js";

function makeLoadOptions(): { options: LoadOptions; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "reminder-store-"));
  const filePath = join(dir, "reminders.json");
  return {
    options: { filePath },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("reminder store", () => {
  it("returns an empty list when the file does not exist", () => {
    const { options, cleanup } = makeLoadOptions();
    try {
      const result = loadReminders(options);
      expect(result.reminders).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("round-trips reminders through save -> load", () => {
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
      saveReminders(reminders, options);
      const loaded = loadReminders(options);
      expect(loaded.reminders).toEqual(reminders);
    } finally {
      cleanup();
    }
  });

  it("treats malformed JSON as empty without throwing", () => {
    const { options, cleanup } = makeLoadOptions();
    try {
      // Pre-write a corrupted file.
      saveReminders([], { filePath: options.filePath });
      // Now overwrite with garbage using the underlying path.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs").writeFileSync(options.filePath, "{not valid json", "utf8");
      const loaded = loadReminders(options);
      expect(loaded.reminders).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

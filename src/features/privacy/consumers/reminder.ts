/**
 * Per-consumer delete adapter for the reminder feature.
 *
 * Removes every reminder where `userId` matches from `data/reminders.json`.
 * Corrupt or missing files are treated as soft success: the user has nothing
 * to delete, and a partial-failure alarm here would be misleading.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DeleteResult } from "../types.js";

export type ReminderDeleteOptions = {
  filePath?: string;
};

const DEFAULT_RELATIVE_PATH = "data/reminders.json";

function resolveFilePath(options: ReminderDeleteOptions): string {
  if (options.filePath) {
    return options.filePath;
  }
  return join(process.cwd(), DEFAULT_RELATIVE_PATH);
}

type ReminderEntry = {
  id: string;
  userId: string;
  message: string;
  fireAt: string;
  createdAt: string;
};
type ReminderStore = { reminders: ReminderEntry[] };

export function deleteUserData(
  userId: string,
  options: ReminderDeleteOptions = {},
): Promise<DeleteResult> {
  const filePath = resolveFilePath(options);

  if (!existsSync(filePath)) {
    return Promise.resolve({ ok: true });
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    let parsed: ReminderStore;
    try {
      parsed = JSON.parse(raw) as ReminderStore;
    } catch {
      return Promise.resolve({ ok: true });
    }
    const reminders = Array.isArray(parsed.reminders) ? parsed.reminders : [];
    const filtered = reminders.filter((reminder) => reminder.userId !== userId);
    if (filtered.length === reminders.length) {
      return Promise.resolve({ ok: true });
    }
    const payload = `${JSON.stringify({ reminders: filtered }, null, 2)}\n`;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, payload, "utf8");
    return Promise.resolve({ ok: true });
  } catch (error) {
    return Promise.resolve({ ok: false, error: stringifyError(error) });
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Per-consumer delete adapter for the reminder feature.
 *
 * Removes every reminder where `userId` matches from `data/reminders.json`.
 * Failures (read / parse / schema / write) surface as `{ ok: false, error }`
 * — ENOENT (no persisted file) is treated as success, since there is
 * nothing to remove.
 */
import { join } from "node:path";
import { z } from "zod";

import { mutateJsonFile } from "../../../lib/storage/atomic-json.js";
import type { DeleteResult } from "../types.js";

export type ReminderDeleteOptions = {
  filePath?: string;
};

const DEFAULT_RELATIVE_PATH = "data/reminders.json";

const entrySchema = z.object({
  id: z.string(),
  userId: z.string(),
  message: z.string(),
  fireAt: z.string(),
  createdAt: z.string(),
});

const storeSchema = z.object({
  reminders: z.array(entrySchema),
});

function resolveFilePath(options: ReminderDeleteOptions): string {
  if (options.filePath) {
    return options.filePath;
  }
  return join(process.cwd(), DEFAULT_RELATIVE_PATH);
}

export function deleteUserData(
  userId: string,
  options: ReminderDeleteOptions = {},
): Promise<DeleteResult> {
  return runDelete(userId, options);
}

async function runDelete(userId: string, options: ReminderDeleteOptions): Promise<DeleteResult> {
  const filePath = resolveFilePath(options);
  const outcome = await mutateJsonFile({
    filePath,
    mutate: (current) => {
      const filtered = current.reminders.filter((reminder) => reminder.userId !== userId);
      if (filtered.length === current.reminders.length) {
        return current;
      }
      return { reminders: filtered };
    },
    schema: storeSchema,
  });

  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  return { ok: true };
}

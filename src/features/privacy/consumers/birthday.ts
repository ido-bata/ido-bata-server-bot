/**
 * Per-consumer delete adapter for the birthday-role feature.
 *
 * Removes the user's entry from `data/birthdays.json` if present. Mirrors
 * the `timekeeper` adapter: failures (read / parse / schema / write) are
 * surfaced as `{ ok: false, error }` so the aggregator can report a
 * partial failure. ENOENT (no persisted file) is treated as success —
 * there is nothing to remove.
 */
import { join } from "node:path";
import { z } from "zod";

import { mutateJsonFile } from "../../../lib/storage/atomic-json.js";
import type { DeleteResult } from "../types.js";

export type BirthdayDeleteOptions = {
  filePath?: string;
};

const DEFAULT_RELATIVE_PATH = "data/birthdays.json";

const entrySchema = z.object({
  date: z.string(),
  updatedAt: z.string(),
  userId: z.string(),
});

const storeSchema = z.object({
  birthdays: z.record(z.string(), entrySchema),
});

function resolveFilePath(options: BirthdayDeleteOptions): string {
  if (options.filePath) {
    return options.filePath;
  }
  return join(process.cwd(), DEFAULT_RELATIVE_PATH);
}

export function deleteUserData(
  userId: string,
  options: BirthdayDeleteOptions = {},
): Promise<DeleteResult> {
  return runDelete(userId, options);
}

async function runDelete(userId: string, options: BirthdayDeleteOptions): Promise<DeleteResult> {
  const filePath = resolveFilePath(options);
  const outcome = await mutateJsonFile({
    filePath,
    mutate: (current) => {
      if (!(userId in current.birthdays)) {
        return current;
      }
      const nextBirthdays = { ...current.birthdays };
      delete nextBirthdays[userId];
      return { birthdays: nextBirthdays };
    },
    schema: storeSchema,
  });

  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  return { ok: true };
}

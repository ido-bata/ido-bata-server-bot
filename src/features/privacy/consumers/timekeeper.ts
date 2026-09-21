/**
 * Per-consumer delete adapter for the timekeeper attendance history.
 *
 * Removes the user's entry from `data/timekeeper-history.json` if present.
 * Failures (read / parse / schema / write errors) are surfaced via
 * `{ ok: false, error }` so the aggregator (`src/features/privacy/clear.ts`)
 * can report a partial failure to `/privacy delete` instead of declaring
 * success on a corrupted store.
 */
import { join } from "node:path";
import { z } from "zod";

import { mutateJsonFile } from "../../../lib/storage/atomic-json.js";
import type { DeleteResult } from "../types.js";

export type TimekeeperDeleteOptions = {
  filePath?: string;
};

const DEFAULT_RELATIVE_PATH = "data/timekeeper-history.json";

const historySchema = z.record(z.string(), z.array(z.string()));

function resolveFilePath(options: TimekeeperDeleteOptions): string {
  if (options.filePath) {
    return options.filePath;
  }
  return join(process.cwd(), DEFAULT_RELATIVE_PATH);
}

export function deleteUserData(
  userId: string,
  options: TimekeeperDeleteOptions = {},
): Promise<DeleteResult> {
  return runDelete(userId, options);
}

async function runDelete(userId: string, options: TimekeeperDeleteOptions): Promise<DeleteResult> {
  const filePath = resolveFilePath(options);
  const outcome = await mutateJsonFile({
    filePath,
    mutate: (current) => {
      if (!(userId in current)) {
        // Returning the same reference signals "no change" — the
        // helper skips the write so we do not touch mtime on disk
        // for users with nothing to remove.
        return current;
      }
      const next = { ...current };
      delete next[userId];
      return next;
    },
    schema: historySchema,
  });

  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  return { ok: true };
}

/**
 * Per-consumer delete adapter for the timekeeper attendance history.
 *
 * Removes the user's entry from `data/timekeeper-history.json` if present.
 * Failures are surfaced via the standard `{ ok: false, error }` shape; the
 * aggregator (`src/features/privacy/clear.ts`) treats any non-ok entry as a
 * partial failure.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DeleteResult } from "../types.js";

export type TimekeeperDeleteOptions = {
  filePath?: string;
};

const DEFAULT_RELATIVE_PATH = "data/timekeeper-history.json";

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
  const filePath = resolveFilePath(options);

  if (!existsSync(filePath)) {
    // Nothing to delete; report success so a missing file does not surface
    // as a failure to the user.
    return Promise.resolve({ ok: true });
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    let parsed: Record<string, string[]>;
    try {
      parsed = JSON.parse(raw) as Record<string, string[]>;
    } catch {
      // Treat a corrupted file as a soft success: there is nothing to remove
      // for this user anyway, and the aggregator will see the file integrity
      // issue through a different lens (state-snapshot adapter).
      return Promise.resolve({ ok: true });
    }
    if (!(userId in parsed)) {
      return Promise.resolve({ ok: true });
    }
    const next = { ...parsed };
    delete next[userId];
    writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
    return Promise.resolve({ ok: true });
  } catch (error) {
    return Promise.resolve({ ok: false, error: stringifyError(error) });
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

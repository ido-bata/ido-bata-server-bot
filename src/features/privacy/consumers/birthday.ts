/**
 * Per-consumer delete adapter for the birthday-role feature.
 *
 * Removes the user's entry from `data/birthdays.json` if present. Mirrors
 * the `timekeeper` adapter: corrupt JSON is treated as soft success (the
 * user has nothing to delete), and a missing file is also ok.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DeleteResult } from "../types.js";

export type BirthdayDeleteOptions = {
  filePath?: string;
};

const DEFAULT_RELATIVE_PATH = "data/birthdays.json";

function resolveFilePath(options: BirthdayDeleteOptions): string {
  if (options.filePath) {
    return options.filePath;
  }
  return join(process.cwd(), DEFAULT_RELATIVE_PATH);
}

type BirthdayEntry = { date: string; updatedAt: string; userId: string };
type BirthdayStore = { birthdays: Record<string, BirthdayEntry> };

export function deleteUserData(
  userId: string,
  options: BirthdayDeleteOptions = {},
): Promise<DeleteResult> {
  const filePath = resolveFilePath(options);

  if (!existsSync(filePath)) {
    return Promise.resolve({ ok: true });
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    let parsed: BirthdayStore;
    try {
      parsed = JSON.parse(raw) as BirthdayStore;
    } catch {
      return Promise.resolve({ ok: true });
    }
    const birthdays = parsed.birthdays ?? {};
    if (!(userId in birthdays)) {
      return Promise.resolve({ ok: true });
    }
    const next: BirthdayStore = { birthdays: { ...birthdays } };
    delete next.birthdays[userId];
    writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return Promise.resolve({ ok: true });
  } catch (error) {
    return Promise.resolve({ ok: false, error: stringifyError(error) });
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

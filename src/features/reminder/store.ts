import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

const reminderSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  message: z.string().min(1),
  // ISO 8601 string. We store as ISO so the persisted JSON is diff-stable
  // across runs and round-trips cleanly through `JSON.parse`.
  fireAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
});

const storeSchema = z.object({
  reminders: z.array(reminderSchema),
});

export type PersistedReminder = z.infer<typeof reminderSchema>;

export type LoadOptions = {
  /**
   * Override the file path. Tests inject a temp file here.
   */
  filePath?: string;
};

export type LoadResult = {
  reminders: PersistedReminder[];
  filePath: string;
};

const DEFAULT_RELATIVE_PATH = join("data", "reminders.json");

export function loadReminders(options: LoadOptions = {}): LoadResult {
  const filePath = options.filePath ?? join(process.cwd(), DEFAULT_RELATIVE_PATH);

  if (!existsSync(filePath)) {
    return { reminders: [], filePath };
  }

  const raw = readFileSync(filePath, "utf8");
  // Defensive: treat unreadable / malformed JSON as an empty store so a
  // corrupted file doesn't crash the bot on boot (matches the timekeeper
  // history pattern from `features/timekeeper/engagement.ts`).
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { reminders: [], filePath };
  }
  const parsed = storeSchema.safeParse(payload);
  if (!parsed.success) {
    return { reminders: [], filePath };
  }

  return { reminders: parsed.data.reminders, filePath };
}

export function saveReminders(
  reminders: readonly PersistedReminder[],
  options: LoadOptions = {},
): string {
  const filePath = options.filePath ?? join(process.cwd(), DEFAULT_RELATIVE_PATH);
  const payload = { reminders: [...reminders] };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

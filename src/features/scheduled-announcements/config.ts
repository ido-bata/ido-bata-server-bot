import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

const JST_OFFSET_MINUTES = 9 * 60;

const entrySchema = z
  .object({
    id: z.string().min(1),
    channelId: z.string().min(1),
    message: z.string().min(1),
    weekday: z.number().int().min(0).max(6).optional(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    oneShotDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "oneShotDate must be YYYY-MM-DD")
      .optional(),
    enabled: z.boolean(),
  })
  .refine(
    (entry) =>
      // Exactly one of weekday or oneShotDate must be present so the scheduler
      // has a clear cadence to evaluate.
      (entry.weekday !== undefined) !== (entry.oneShotDate !== undefined),
    { message: "Each entry needs exactly one of weekday or oneShotDate" },
  );

export const scheduledAnnouncementsFileSchema = z.object({
  entries: z.array(entrySchema),
});

export type ScheduledAnnouncementEntry = z.infer<typeof entrySchema>;

const DEFAULT_RELATIVE_PATH = join("data", "scheduled-announcements.json");

export type LoadOptions = {
  /**
   * Override the file path. Tests inject a temp file here.
   */
  filePath?: string;
};

export type LoadResult = {
  entries: ScheduledAnnouncementEntry[];
  filePath: string;
};

export function loadScheduledAnnouncements(options: LoadOptions = {}): LoadResult {
  const filePath = options.filePath ?? join(process.cwd(), DEFAULT_RELATIVE_PATH);

  if (!existsSync(filePath)) {
    return { entries: [], filePath };
  }

  const raw = readFileSync(filePath, "utf8");
  const parsed = scheduledAnnouncementsFileSchema.parse(JSON.parse(raw));
  return { entries: parsed.entries, filePath };
}

export function saveScheduledAnnouncements(
  entries: ScheduledAnnouncementEntry[],
  options: LoadOptions = {},
): string {
  const filePath = options.filePath ?? join(process.cwd(), DEFAULT_RELATIVE_PATH);
  const payload = { entries };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

export function getJstOffsetMinutes(): number {
  return JST_OFFSET_MINUTES;
}

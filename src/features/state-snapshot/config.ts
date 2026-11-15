import { z } from "zod";

const snapshotConfigSchema = z.object({
  snapshotPrefix: z.string().min(1),
  sourceKeys: z.array(z.string().min(1)).min(1),
  dailyRetention: z.number().int().positive(),
  weeklyRetention: z.number().int().positive(),
  monthlyRetention: z.number().int().positive(),
  snapshotHourJst: z.number().int().min(0).max(23),
  snapshotMinuteJst: z.number().int().min(0).max(59),
  uploadRepo: z.string().optional(),
  uploadBranch: z.string().min(1).optional(),
  uploadToken: z.string().min(1).optional(),
});

export type SnapshotConfig = z.infer<typeof snapshotConfigSchema>;

export type SnapshotRuntimeOptions = {
  snapshotPrefix?: string;
  sourceKeys?: string[];
  dailyRetention?: number;
  weeklyRetention?: number;
  monthlyRetention?: number;
  snapshotHourJst?: number;
  snapshotMinuteJst?: number;
  uploadRepo?: string;
  uploadBranch?: string;
  uploadToken?: string;
};

/**
 * Default snapshot sources.
 *
 * The list MUST mirror the persistent inventory documented in
 * `docs/privacy.md` so a `/privacy delete` purge is mirrored by the
 * encrypted snapshot — otherwise a snapshot restored to a fresh host
 * would resurrect data the user already deleted. Add new persistent
 * consent-gated files here too.
 *
 * The entries are storage keys (ADR-0004): the local backend resolves
 * them under `data/`, object storage under the bucket root.
 */
export const DEFAULT_SNAPSHOT_SOURCE_KEYS: ReadonlyArray<string> = [
  "consent.json",
  "birthdays.json",
  "polls.json",
  "reminders.json",
  "timekeeper-history.json",
];

export function readSnapshotConfig(options: SnapshotRuntimeOptions = {}): SnapshotConfig {
  return snapshotConfigSchema.parse({
    snapshotPrefix: options.snapshotPrefix ?? "snapshots",
    sourceKeys: options.sourceKeys ?? [...DEFAULT_SNAPSHOT_SOURCE_KEYS],
    dailyRetention: options.dailyRetention ?? 7,
    weeklyRetention: options.weeklyRetention ?? 4,
    monthlyRetention: options.monthlyRetention ?? 12,
    snapshotHourJst: options.snapshotHourJst ?? 3,
    snapshotMinuteJst: options.snapshotMinuteJst ?? 0,
    uploadRepo:
      options.uploadRepo ??
      process.env.STATE_SNAPSHOT_UPLOAD_REPO ??
      process.env.GITHUB_REPOSITORY ??
      undefined,
    uploadBranch:
      options.uploadBranch ?? process.env.STATE_SNAPSHOT_UPLOAD_BRANCH ?? "state-snapshots",
    uploadToken:
      options.uploadToken ??
      process.env.STATE_SNAPSHOT_UPLOAD_TOKEN ??
      process.env.GITHUB_TOKEN ??
      undefined,
  });
}

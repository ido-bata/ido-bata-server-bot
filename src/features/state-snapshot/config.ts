import { z } from "zod";

export const snapshotConfigSchema = z.object({
  snapshotDir: z.string().min(1),
  sourcePaths: z.array(z.string().min(1)).min(1),
  dailyRetention: z.number().int().positive(),
  weeklyRetention: z.number().int().positive(),
  monthlyRetention: z.number().int().positive(),
  snapshotHourJst: z.number().int().min(0).max(23),
  snapshotMinuteJst: z.number().int().min(0).max(59),
});

export type SnapshotConfig = z.infer<typeof snapshotConfigSchema>;

export type SnapshotRuntimeOptions = {
  snapshotDir?: string;
  sourcePaths?: string[];
  dailyRetention?: number;
  weeklyRetention?: number;
  monthlyRetention?: number;
  snapshotHourJst?: number;
  snapshotMinuteJst?: number;
};

export function readSnapshotConfig(options: SnapshotRuntimeOptions = {}): SnapshotConfig {
  return snapshotConfigSchema.parse({
    snapshotDir: options.snapshotDir ?? "data/snapshots",
    sourcePaths: options.sourcePaths ?? [
      "data/bot.db",
      "data/timekeeper-history.json",
    ],
    dailyRetention: options.dailyRetention ?? 7,
    weeklyRetention: options.weeklyRetention ?? 4,
    monthlyRetention: options.monthlyRetention ?? 12,
    snapshotHourJst: options.snapshotHourJst ?? 3,
    snapshotMinuteJst: options.snapshotMinuteJst ?? 0,
  });
}

export function isSnapshotConfigured(config: SnapshotConfig): boolean {
  return config.sourcePaths.length > 0;
}
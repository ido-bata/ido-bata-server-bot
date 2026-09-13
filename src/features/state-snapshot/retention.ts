import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { decryptBuffer, resolveEncryptionKey } from "./encryption.js";
import { type SnapshotMetadata } from "./snapshot.js";

export type RetentionPolicy = {
  dailyRetention: number;
  weeklyRetention: number;
  monthlyRetention: number;
};

export type Bucket = "daily" | "weekly" | "monthly";

export type ClassifiedSnapshot = {
  bucket: Bucket;
  metadata: SnapshotMetadata;
};

const ISO_DATE_LENGTH = 10;
const WEEK_MS = 7 * 86_400_000;
const MONTH_MS = 30 * 86_400_000;

export function classifySnapshot(
  metadata: SnapshotMetadata,
  referenceDate: Date = new Date(metadata.createdAt),
): ClassifiedSnapshot {
  const createdAt = new Date(metadata.createdAt);
  const ageMs = referenceDate.getTime() - createdAt.getTime();

  if (ageMs >= MONTH_MS) {
    return { bucket: "monthly", metadata };
  }
  if (ageMs >= WEEK_MS) {
    return { bucket: "weekly", metadata };
  }
  return { bucket: "daily", metadata };
}

export type RetentionPlan = {
  keep: SnapshotMetadata[];
  delete: SnapshotMetadata[];
};

export function planRetention(
  snapshots: SnapshotMetadata[],
  policy: RetentionPolicy,
  referenceDate: Date = new Date(),
): RetentionPlan {
  const keep: SnapshotMetadata[] = [];
  const deleteEntries: SnapshotMetadata[] = [];

  // Group by bucket. Within a bucket, sort oldest -> newest so we always keep the
  // most recent N.
  const byBucket: Record<Bucket, SnapshotMetadata[]> = {
    daily: [],
    monthly: [],
    weekly: [],
  };
  for (const snapshot of snapshots) {
    byBucket[classifySnapshot(snapshot, referenceDate).bucket].push(snapshot);
  }

  for (const bucket of ["daily", "weekly", "monthly"] as const) {
    const entries = byBucket[bucket].slice().sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    const limit = policy[`${bucket}Retention`];
    const overflow = entries.length - limit;

    if (overflow > 0) {
      deleteEntries.push(...entries.slice(0, overflow));
      keep.push(...entries.slice(overflow));
    } else {
      keep.push(...entries);
    }
  }

  // De-duplicate while preserving keep precedence.
  const seen = new Set<string>();
  const dedupedKeep: SnapshotMetadata[] = [];
  for (const entry of keep) {
    if (seen.has(entry.path)) {
      continue;
    }
    seen.add(entry.path);
    dedupedKeep.push(entry);
  }

  const deleteSet = new Set(deleteEntries.map((entry) => entry.path));
  for (const entry of dedupedKeep) {
    deleteSet.delete(entry.path);
  }

  return {
    delete: [...deleteSet].map((path) => {
      const found = snapshots.find((snapshot) => snapshot.path === path);
      if (!found) {
        throw new Error(`Retention plan referenced missing snapshot: ${path}`);
      }
      return found;
    }),
    keep: dedupedKeep,
  };
}

export function applyRetentionPlan(
  plan: RetentionPlan,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  for (const entry of plan.delete) {
    if (!existsSync(entry.path)) {
      continue;
    }
    if (options.dryRun) {
      continue;
    }
    try {
      unlinkSync(entry.path);
    } catch {
      // Best-effort: a single unlink failure should not stop the rest of the plan.
    }
  }
  return Promise.resolve();
}

export function verifySnapshotIntegrity(snapshotPath: string, hexKey: string): boolean {
  if (!existsSync(snapshotPath)) {
    return false;
  }
  try {
    const key = resolveEncryptionKey(hexKey);
    const buffer = readFileSync(snapshotPath);
    if (buffer.length < 28) {
      return false;
    }
    const iv = buffer.subarray(0, 12);
    const authTag = buffer.subarray(12, 28);
    const ciphertext = buffer.subarray(28);
    decryptBuffer({ authTag, ciphertext, iv }, key);
    return true;
  } catch {
    return false;
  }
}

export function isoDateOf(metadata: SnapshotMetadata): string {
  return metadata.createdAt.slice(0, ISO_DATE_LENGTH);
}
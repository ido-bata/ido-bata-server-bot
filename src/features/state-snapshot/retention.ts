import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { decryptBuffer, resolveEncryptionKey } from "./encryption.js";
import type { SnapshotMetadata } from "./snapshot.js";

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
const ISO_MONTH_LENGTH = 7;
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
  // Generational retention: each tier keeps at most one representative per
  // time bucket (day / ISO week / calendar month) and only the N most recent
  // buckets survive. This is what makes "7 daily / 4 weekly / 12 monthly"
  // actually mean "7 distinct days, 4 distinct ISO weeks, 12 distinct months".
  const sorted = snapshots
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  const dailyKeep = pickTierKeep(
    sorted,
    isDailyCandidate,
    dayKeyOf,
    policy.dailyRetention,
    referenceDate,
  );
  const dailyPaths = new Set(dailyKeep.map((entry) => entry.path));

  const weeklyKeep = pickTierKeep(
    sorted.filter((entry) => !dailyPaths.has(entry.path)),
    isWeeklyCandidate,
    isoWeekKeyOf,
    policy.weeklyRetention,
    referenceDate,
  );
  const weeklyPaths = new Set(weeklyKeep.map((entry) => entry.path));

  const monthlyKeep = pickTierKeep(
    sorted.filter((entry) => !dailyPaths.has(entry.path) && !weeklyPaths.has(entry.path)),
    isMonthlyCandidate,
    monthKeyOf,
    policy.monthlyRetention,
    referenceDate,
  );

  const keepSet = new Set<string>();
  const keepList: SnapshotMetadata[] = [];
  for (const entry of [...dailyKeep, ...weeklyKeep, ...monthlyKeep]) {
    if (keepSet.has(entry.path)) {
      continue;
    }
    keepSet.add(entry.path);
    keepList.push(entry);
  }

  const deleteList: SnapshotMetadata[] = [];
  for (const entry of sorted) {
    if (!keepSet.has(entry.path)) {
      deleteList.push(entry);
    }
  }

  return { delete: deleteList, keep: keepList };
}

function pickTierKeep(
  candidates: SnapshotMetadata[],
  isEligible: (snapshot: SnapshotMetadata, referenceDate: Date) => boolean,
  groupKeyOf: (snapshot: SnapshotMetadata) => string,
  limit: number,
  referenceDate: Date,
): SnapshotMetadata[] {
  const eligible = candidates.filter((snapshot) => isEligible(snapshot, referenceDate));
  // Pick the most recent snapshot per group key (one per day / week / month).
  const representativeByGroup = new Map<string, SnapshotMetadata>();
  for (const snapshot of eligible) {
    const key = groupKeyOf(snapshot);
    const existing = representativeByGroup.get(key);
    if (!existing || snapshot.createdAt > existing.createdAt) {
      representativeByGroup.set(key, snapshot);
    }
  }
  // Iterate groups in newest-first order so the limit keeps the most recent N.
  const groups = [...representativeByGroup.entries()].sort(([leftKey], [rightKey]) =>
    rightKey.localeCompare(leftKey),
  );
  return groups.slice(0, limit).map(([, snapshot]) => snapshot);
}

function isDailyCandidate(snapshot: SnapshotMetadata, referenceDate: Date): boolean {
  return ageOf(snapshot, referenceDate) < WEEK_MS;
}

function isWeeklyCandidate(snapshot: SnapshotMetadata, referenceDate: Date): boolean {
  const age = ageOf(snapshot, referenceDate);
  return age >= WEEK_MS && age < MONTH_MS;
}

function isMonthlyCandidate(snapshot: SnapshotMetadata, referenceDate: Date): boolean {
  return ageOf(snapshot, referenceDate) >= MONTH_MS;
}

function ageOf(snapshot: SnapshotMetadata, referenceDate: Date): number {
  return referenceDate.getTime() - new Date(snapshot.createdAt).getTime();
}

function dayKeyOf(snapshot: SnapshotMetadata): string {
  return snapshot.createdAt.slice(0, ISO_DATE_LENGTH);
}

function monthKeyOf(snapshot: SnapshotMetadata): string {
  return snapshot.createdAt.slice(0, ISO_MONTH_LENGTH);
}

// ISO week key (e.g. "2026-W12") based on UTC components of createdAt.
// Uses the standard algorithm: the ISO week is determined by the Thursday of
// the calendar week the date falls in.
export function isoWeekKeyOf(snapshot: SnapshotMetadata): string {
  return isoWeekKeyOfDate(new Date(snapshot.createdAt));
}

export function isoWeekKeyOfDate(date: Date): string {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Shift to the Thursday of the same ISO week: Monday = 1, ..., Sunday = 7.
  const dayOfWeek = target.getUTCDay() === 0 ? 7 : target.getUTCDay();
  target.setUTCDate(target.getUTCDate() + (4 - dayOfWeek));
  const isoYear = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const weekNumber = Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(weekNumber).padStart(2, "0")}`;
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

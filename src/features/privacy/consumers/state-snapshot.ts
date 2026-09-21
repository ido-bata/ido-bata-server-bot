/**
 * Per-consumer delete adapter for the encrypted state-snapshot feature.
 *
 * Snapshots are AES-256-GCM bundles that mirror every consent-gated source
 * file. After a user runs `/privacy delete`, every snapshot taken before the
 * call is, by definition, eligible for purging — we cannot inspect encrypted
 * bytes to know whether the user id appears, so we trigger
 * `applyRetentionPlan` with a keep-nothing policy.
 *
 * The actual snapshot files live under `data/snapshots/`. If the directory
 * does not exist or is empty, this adapter is a no-op success.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { applyRetentionPlan, planRetention } from "../../state-snapshot/retention.js";
import type { DeleteResult } from "../types.js";

export type SnapshotDeleteOptions = {
  snapshotDir?: string;
  /**
   * Override `now()` for deterministic tests. Defaults to `() => new Date()`.
   */
  now?: () => Date;
};

const DEFAULT_RELATIVE_DIR = "data/snapshots";

function resolveSnapshotDir(options: SnapshotDeleteOptions): string {
  if (options.snapshotDir) {
    return options.snapshotDir;
  }
  return join(process.cwd(), DEFAULT_RELATIVE_DIR);
}

function listSnapshotPaths(snapshotDir: string): string[] {
  if (!existsSync(snapshotDir)) {
    return [];
  }
  return readdirSync(snapshotDir)
    .filter((name) => name.endsWith(".snap.enc"))
    .map((name) => join(snapshotDir, name));
}

export function deleteUserData(
  _userId: string,
  options: SnapshotDeleteOptions = {},
): Promise<DeleteResult> {
  const snapshotDir = resolveSnapshotDir(options);
  const paths = listSnapshotPaths(snapshotDir);

  if (paths.length === 0) {
    return Promise.resolve({ ok: true });
  }

  try {
    // We deliberately skip per-snapshot decryption: every snapshot is a
    // potential carrier of the user's data, so we want to mark all of them
    // for deletion. Synthetic metadata with `createdAt = now` is sufficient
    // — planRetention only needs createdAt + path to make a decision, and
    // the policy below keeps none of them anyway.
    const now = (options.now ?? (() => new Date()))().toISOString();
    const metadata = paths.map((path, index) => ({
      createdAt: now,
      files: [],
      id: `privacy-clear-${index}`,
      path,
    }));
    const plan = planRetention(metadata, {
      dailyRetention: 0,
      monthlyRetention: 0,
      weeklyRetention: 0,
    });
    // applyRetentionPlan is signature-async but does no real I/O awaits.
    // We need to surface any aggregate failure; the underlying function
    // swallows per-file errors and resolves to void. To honour the
    // "partial failure = failure" invariant, re-stat the snapshot directory
    // after the plan runs and report any leftover files.
    applyRetentionPlan(plan);
    const remaining = listSnapshotPaths(snapshotDir);
    if (remaining.length > 0) {
      return Promise.resolve({
        ok: false,
        error: `failed to purge ${remaining.length} snapshot file(s)`,
      });
    }
    return Promise.resolve({ ok: true });
  } catch (error) {
    return Promise.resolve({ ok: false, error: stringifyError(error) });
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Per-consumer delete adapter for the encrypted state-snapshot feature.
 *
 * Snapshots are AES-256-GCM bundles that mirror every consent-gated source
 * file. After a user runs `/privacy delete`, every snapshot taken before the
 * call is potentially eligible for purging — we cannot inspect encrypted
 * bytes to know whether the user id appears.
 *
 * v0.2.0-rc bug: the adapter used to take a zero-retention plan and wipe
 * ALL snapshots. A single user's `/privacy delete` therefore erased the
 * only backup for every other user. The fix routes the deletion through
 * `purgeAllSnapshots`, which (a) requires a fresh snapshot to be taken
 * first via `takeFreshSnapshot`, then (b) keeps only that fresh path and
 * deletes everything else. Without `takeFreshSnapshot` wired the purge
 * declines to act, so the operator sees a warning instead of a silent
 * data loss.
 *
 * The actual snapshot files live under `data/snapshots/`. If the directory
 * does not exist or is empty, this adapter is a no-op success.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { purgeAllSnapshots } from "../../state-snapshot/service.js";
import type { DeleteResult } from "../types.js";

export type SnapshotDeleteOptions = {
  snapshotDir?: string;
  /**
   * Capture the post-clear state into a fresh snapshot before any purge
   * runs. Required whenever there are existing *.snap.enc files to drop.
   * Without it we cannot safely wipe the snapshots, so the adapter
   * returns ok:false instead of half-purging.
   */
  takeFreshSnapshot?: () => Promise<string | null>;
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

/**
 * Detect whether the configured snapshot directory holds any
 * `.snap.enc` files that would need a destructive purge. The check
 * short-circuits when the wiring hook is missing — no snapshots means
 * nothing to drop, so the missing hook is irrelevant.
 */
function hasSnapshots(snapshotDir: string): boolean {
  if (!existsSync(snapshotDir)) {
    return false;
  }
  return readdirSync(snapshotDir).some((name) => name.endsWith(".snap.enc"));
}

export async function deleteUserData(
  userId: string,
  options: SnapshotDeleteOptions = {},
): Promise<DeleteResult> {
  const snapshotDir = resolveSnapshotDir(options);

  if (options.takeFreshSnapshot === undefined && hasSnapshots(snapshotDir)) {
    // The composition root MUST wire `takeFreshSnapshot` so the destructive
    // pass has somewhere to copy the post-clear state. Without the fresh
    // snapshot there is no safe way to drop existing *.snap.enc files — a
    // misconfigured caller who forgets the hook sees ok:false instead of
    // silent data retention.
    return {
      ok: false,
      error: "state-snapshot fresh snapshot hook is required for purge",
    };
  }

  try {
    const result = await purgeAllSnapshots({
      snapshotDir,
      encryptionKey: process.env.STATE_SNAPSHOT_ENCRYPTION_KEY,
      clock: options.now,
      takeFreshSnapshot: options.takeFreshSnapshot,
      subjectId: userId,
    });
    if (!result.ok) {
      // Surface a non-ok so the privacy-delete consumer can fail the
      // overall /privacy delete. Silent success would let a hook that
      // returned null/throw wipe the only deployment backup without
      // the operator being told — see PR review Yfyp.
      return { ok: false, error: result.error };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: stringifyError(error) };
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Per-consumer delete adapter for the encrypted state-snapshot feature.
 *
 * Snapshots are AES-256-GCM bundles that mirror every consent-gated source
 * object. After a user runs `/privacy delete`, every snapshot taken before
 * the call is potentially eligible for purging — we cannot inspect
 * encrypted bytes to know whether the user id appears.
 *
 * v0.2.0-rc bug: the adapter used to take a zero-retention plan and wipe
 * ALL snapshots. A single user's `/privacy delete` therefore erased the
 * only backup for every other user. The fix routes the deletion through
 * `purgeAllSnapshots`, which (a) requires a fresh snapshot to be taken
 * first via `takeFreshSnapshot`, then (b) keeps only that fresh object and
 * deletes everything else. Without `takeFreshSnapshot` wired the purge
 * declines to act, so the operator sees a warning instead of a silent
 * data loss.
 *
 * The snapshots live under the `snapshots/` storage prefix (ADR-0004):
 * `data/snapshots/` on a single host, `snapshots/` in the U3 bucket on
 * Altare. An empty prefix is a no-op success.
 */
import { getStorageDriver } from "../../../lib/storage/index.js";
import type { StorageDriver } from "../../../lib/storage/types.js";
import { purgeAllSnapshots } from "../../state-snapshot/service.js";
import type { DeleteResult } from "../types.js";

export type SnapshotDeleteOptions = {
  /** Storage key prefix that holds the encrypted snapshots. */
  snapshotPrefix?: string;
  /** Storage backend holding the snapshots. */
  driver?: StorageDriver;
  /**
   * Capture the post-clear state into a fresh snapshot before any purge
   * runs. Required whenever there are existing *.snap.enc objects to
   * drop. Without it we cannot safely wipe the snapshots, so the adapter
   * returns ok:false instead of half-purging.
   */
  takeFreshSnapshot?: () => Promise<string | null>;
  /**
   * Override `now()` for deterministic tests. Defaults to `() => new Date()`.
   */
  now?: () => Date;
};

const DEFAULT_SNAPSHOT_PREFIX = "snapshots";

/**
 * Detect whether the configured snapshot prefix holds any `.snap.enc`
 * objects that would need a destructive purge. The check short-circuits
 * when the wiring hook is missing — no snapshots means nothing to drop,
 * so the missing hook is irrelevant.
 */
async function hasSnapshots(prefix: string, driver: StorageDriver): Promise<boolean> {
  const entries = await driver.list(`${prefix}/`);
  return entries.some((entry) => entry.key.endsWith(".snap.enc"));
}

export async function deleteUserData(
  userId: string,
  options: SnapshotDeleteOptions = {},
): Promise<DeleteResult> {
  const snapshotPrefix = options.snapshotPrefix ?? DEFAULT_SNAPSHOT_PREFIX;
  const driver = options.driver ?? getStorageDriver();

  try {
    if (options.takeFreshSnapshot === undefined && (await hasSnapshots(snapshotPrefix, driver))) {
      // The composition root MUST wire `takeFreshSnapshot` so the destructive
      // pass has somewhere to copy the post-clear state. Without the fresh
      // snapshot there is no safe way to drop existing *.snap.enc objects — a
      // misconfigured caller who forgets the hook sees ok:false instead of
      // silent data retention.
      return {
        ok: false,
        error: "state-snapshot fresh snapshot hook is required for purge",
      };
    }

    const result = await purgeAllSnapshots({
      driver,
      encryptionKey: process.env.STATE_SNAPSHOT_ENCRYPTION_KEY,
      clock: options.now,
      snapshotPrefix,
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

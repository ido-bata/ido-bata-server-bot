import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "discord.js";
import { Events } from "discord.js";
import type { ConsentService } from "../../consent/service.js";
import { childFor, getRootLogger } from "../../lib/logger/index.js";
import type { SnapshotConfig } from "./config.js";
import { applyRetentionPlan, planRetention, type RetentionPolicy } from "./retention.js";
import { getNextSnapshotStartAt } from "./schedule.js";
import {
  createSnapshot,
  ensureSnapshotDir,
  listSnapshots,
  loadEncryptedSnapshot,
  type SnapshotMetadata,
} from "./snapshot.js";
import {
  createCompositeUploader,
  createGitHubApiUploader,
  createNoopUploader,
  type SnapshotUploader,
} from "./uploaders.js";

const logger = childFor(getRootLogger(), "state-snapshot");

type SnapshotDependencies = {
  encryptionKey?: string;
  runOnReady?: boolean;
  clock?: () => Date;
  uploader?: SnapshotUploader;
  /**
   * v0.2.0: optional `ConsentService`. When provided, every `clear` event
   * triggers `applyRetentionPlan` with a keep-nothing policy so any
   * snapshot whose source files contained the revoked subject is purged.
   */
  consentService?: ConsentService;
};

export type SnapshotRuntime = {
  config: SnapshotConfig;
  encryptionKey: string | undefined;
  runOnReady: boolean;
  clock: () => Date;
  uploader: SnapshotUploader;
};

export function createSnapshotRuntime(
  config: SnapshotConfig,
  dependencies: SnapshotDependencies = {},
): SnapshotRuntime {
  const uploader = dependencies.uploader ?? buildUploaderFromConfig(config);
  return {
    clock: dependencies.clock ?? (() => new Date()),
    config,
    encryptionKey: dependencies.encryptionKey ?? process.env.STATE_SNAPSHOT_ENCRYPTION_KEY,
    runOnReady: dependencies.runOnReady ?? false,
    uploader,
  };
}

export function registerStateSnapshotScheduler(
  client: Client,
  runtime: SnapshotRuntime,
  options: { consentService?: ConsentService } = {},
): { cancel: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let cancelled = false;
  let detachConsent: (() => void) | null = null;

  if (options.consentService) {
    detachConsent = options.consentService.subscribe((event) => {
      if (event.kind !== "clear") {
        return;
      }
      // v0.2.0 invariant: every snapshot whose source files contained the
      // revoked subject is purged on `clear`. We cannot inspect encrypted
      // bytes, so the keep-nothing policy is the safe choice — but only
      // AFTER a fresh snapshot captures the post-clear state. Without the
      // fresh snapshot, a single user could erase the only deployment
      // backup. The `takeFreshSnapshot` hook is the take-snapshot-half of
      // the contract: existing snapshots before `now()` are dropped, the
      // freshly-created one is preserved.
      void purgeAllSnapshots({
        snapshotDir: runtime.config.snapshotDir,
        encryptionKey: runtime.encryptionKey,
        clock: runtime.clock,
        takeFreshSnapshot: async () => {
          const created = await runSnapshotOnce(runtime);
          return created.path;
        },
        subjectId: event.subjectId,
      }).catch((error: unknown) => {
        logger.error(
          { err: error, subjectId: event.subjectId },
          "retention purge after clear failed",
        );
      });
    });
  }

  const schedule = (): void => {
    if (cancelled) {
      return;
    }
    const nextStartAt = getNextSnapshotStartAt(
      runtime.clock(),
      runtime.config.snapshotHourJst,
      runtime.config.snapshotMinuteJst,
    );
    const delayMs = Math.max(0, nextStartAt.getTime() - runtime.clock().getTime());
    logger.info(
      { nextStartAt: nextStartAt.toISOString(), delaySeconds: Math.round(delayMs / 1000) },
      "next snapshot scheduled",
    );

    timer = setTimeout(() => {
      void runSnapshotOnce(runtime)
        .catch((error: unknown) => {
          logger.error({ err: error }, "scheduled snapshot failed");
        })
        .finally(() => {
          schedule();
        });
    }, delayMs);
  };

  client.once(Events.ClientReady, () => {
    if (runtime.runOnReady) {
      logger.info("running snapshot immediately because STATE_SNAPSHOT_RUN_ON_READY=true");
      void runSnapshotOnce(runtime).catch((error: unknown) => {
        logger.error({ err: error }, "immediate snapshot failed");
      });
      return;
    }
    schedule();
  });

  return {
    cancel: () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (detachConsent) {
        detachConsent();
        detachConsent = null;
      }
    },
  };
}

export async function runSnapshotOnce(runtime: SnapshotRuntime): Promise<SnapshotMetadata> {
  ensureSnapshotDir(runtime.config.snapshotDir);
  const created = await createSnapshot(
    {
      snapshotDir: runtime.config.snapshotDir,
      sourcePaths: runtime.config.sourcePaths,
    },
    runtime.encryptionKey,
    runtime.clock(),
  );

  const plan = planRetention(
    listSnapshots(runtime.config.snapshotDir, runtime.encryptionKey),
    toRetentionPolicy(runtime.config),
    runtime.clock(),
  );
  await applyRetentionPlan(plan);

  await uploadSnapshot(runtime, created);
  return created;
}

async function uploadSnapshot(runtime: SnapshotRuntime, created: SnapshotMetadata): Promise<void> {
  let encrypted: Awaited<ReturnType<typeof loadEncryptedSnapshot>>;
  try {
    // Validate the bytes are an actual encrypted container BEFORE they
    // reach the uploader boundary. `loadEncryptedSnapshot` rejects
    // missing / too-small / unencrypted files; whatever survives is
    // safe to upload.
    encrypted = loadEncryptedSnapshot(created.path);
  } catch (error) {
    logger.error(
      { uploader: runtime.uploader.name, path: created.path, err: error },
      "snapshot validation failed before upload",
    );
    return;
  }
  try {
    await runtime.uploader.upload(encrypted);
  } catch (error) {
    logger.error(
      { uploader: runtime.uploader.name, path: created.path, err: error },
      "uploader failed",
    );
  }
}

function buildUploaderFromConfig(config: SnapshotConfig): SnapshotUploader {
  const parts: SnapshotUploader[] = [];
  if (config.uploadRepo && config.uploadBranch && config.uploadToken) {
    parts.push(
      createGitHubApiUploader({
        branch: config.uploadBranch,
        repo: config.uploadRepo,
        token: config.uploadToken,
      }),
    );
  }
  if (parts.length === 0) {
    parts.push(createNoopUploader());
  }
  return createCompositeUploader(parts);
}

function toRetentionPolicy(config: SnapshotConfig): RetentionPolicy {
  return {
    dailyRetention: config.dailyRetention,
    monthlyRetention: config.monthlyRetention,
    weeklyRetention: config.weeklyRetention,
  };
}

/**
 * Purges every snapshot in the directory while preserving a single
 * "fresh" snapshot taken immediately beforehand. Used by the v0.2.0
 * `ConsentService.clear` listener and the privacy-clear adapter because
 * we cannot inspect encrypted bytes to know which snapshots contain
 * the revoked subject.
 *
 * Two changes vs. the v0.2.0-rc behaviour:
 *
 * 1. **Bypass decryption for file enumeration.** `listSnapshots` filters
 *    out files whose metadata cannot be decrypted, leaving stale
 *    encrypted bytes on disk while reporting success. We enumerate
 *    `*.snap.enc` directly via `readdirSync` so the purge actually
 *    reaps every file (CWE-459 sensitive-data-exposure).
 *
 * 2. **Take a fresh snapshot before the wipe.** Without this hook
 *    a single user's `/privacy delete` could erase the only backup of
 *    every other user's state. The caller MUST provide
 *    `takeFreshSnapshot`; if absent, this function declines to act
 *    and logs a warning, so a developer who forgets the seam sees
 *    noisy telemetry instead of silent data loss.
 *
 * Exported so the privacy-clear test can assert the wire-up without
 * running the full scheduler loop.
 */
/**
 * Outcome of a purge attempt. Surfaced to the privacy-delete caller so the
 * reply can distinguish "everything was wiped" from "snapshot subsystem
 * declined to delete (retry later)" — silent deletion must NOT be implied
 * either way. See PR review Yfyp.
 */
export type PurgeSnapshotsResult =
  | { ok: true; deleted: number; kept: string | null }
  | { ok: false; error: string };

export async function purgeAllSnapshots(options: {
  snapshotDir: string;
  encryptionKey: string | undefined;
  clock?: () => Date;
  /**
   * Capture the post-clear state into a fresh snapshot BEFORE the
   * destructive pass. Returns the absolute path of the freshly-written
   * snapshot, which is preserved by the purge. When this hook is
   * required (i.e., existing snapshots would otherwise be deleted) it
   * MUST resolve with a non-null file path; resolving `null` or
   * throwing is treated as a refusal to delete so the existing
   * snapshots are preserved.
   */
  takeFreshSnapshot?: () => Promise<string | null>;
  subjectId?: string;
}): Promise<PurgeSnapshotsResult> {
  if (!existsSync(options.snapshotDir)) {
    return { ok: true, deleted: 0, kept: null };
  }
  const paths = readdirSync(options.snapshotDir)
    .filter((name) => name.endsWith(".snap.enc"))
    .map((name) => join(options.snapshotDir, name));
  if (paths.length === 0) {
    return { ok: true, deleted: 0, kept: null };
  }
  if (!options.takeFreshSnapshot) {
    logger.warn(
      {
        snapshotDir: options.snapshotDir,
        count: paths.length,
        subjectId: options.subjectId,
      },
      "purgeAllSnapshots declined: no takeFreshSnapshot hook wired; retaining existing snapshots",
    );
    return {
      ok: false,
      error: "fresh snapshot hook is required; no purge performed",
    };
  }
  let freshPath: string | null = null;
  try {
    freshPath = await options.takeFreshSnapshot();
  } catch (error) {
    logger.error(
      { err: error, subjectId: options.subjectId },
      "purgeAllSnapshots: fresh snapshot failed; declining to purge",
    );
    return {
      ok: false,
      error: `fresh snapshot failed: ${(error as Error)?.message ?? String(error)}`,
    };
  }
  // The fresh-snapshot hook returned null (e.g. nothing to archive). We
  // refuse to wipe existing snapshots in that case — silently deleting
  // the only backup would make `/privacy delete` claim success while
  // leaving the user with no recoverable state.
  if (!freshPath) {
    logger.error(
      { subjectId: options.subjectId },
      "purgeAllSnapshots: fresh snapshot hook returned null; declining to purge",
    );
    return {
      ok: false,
      error: "fresh snapshot hook returned null; existing snapshots retained",
    };
  }
  const clock = options.clock ?? (() => new Date());
  const keepPaths = new Set<string>();
  keepPaths.add(freshPath);
  const nowIso = clock().toISOString();
  // Synthesize a retention plan that keeps ONLY the freshly written
  // snapshot (when it exists) and deletes every other *.snap.enc file
  // on disk, even ones listSnapshots could not decrypt. Using the plan
  // pipeline reuses applyRetentionPlan's per-file error swallowing.
  const keep = [
    {
      createdAt: nowIso,
      files: [],
      id: `fresh-${Date.now()}`,
      path: freshPath,
    },
  ];
  const del = paths
    .filter((path) => !keepPaths.has(path))
    .map((path, index) => ({
      createdAt: nowIso,
      files: [],
      id: `stale-${index}`,
      path,
    }));
  const plan = { keep, delete: del };
  await applyRetentionPlan(plan);
  // Re-stat the directory: if anything OTHER than the fresh snapshot we
  // intend to keep is still on disk, that's a leaked file the retention
  // pass couldn't unlink (permission denied, EISDIR, etc.) and must
  // surface so the operator can intervene instead of silently leaking.
  const remaining = readdirSync(options.snapshotDir).filter((name) => name.endsWith(".snap.enc"));
  const leftover = remaining.filter((name) => join(options.snapshotDir, name) !== freshPath);
  if (leftover.length > 0) {
    return {
      ok: false,
      error: `failed to purge ${leftover.length} snapshot file(s)`,
    };
  }
  return { ok: true, deleted: del.length, kept: freshPath };
}

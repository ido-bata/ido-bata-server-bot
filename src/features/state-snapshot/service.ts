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
      // bytes, so the keep-nothing policy is the safe choice — better to
      // lose a few snapshots than to retain a stale copy of the user's
      // data.
      try {
        purgeAllSnapshots({
          snapshotDir: runtime.config.snapshotDir,
          encryptionKey: runtime.encryptionKey,
          clock: runtime.clock,
        });
      } catch (error) {
        logger.error(
          { err: error, subjectId: event.subjectId },
          "retention purge after clear failed",
        );
      }
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

async function runSnapshotOnce(runtime: SnapshotRuntime): Promise<void> {
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
}

async function uploadSnapshot(runtime: SnapshotRuntime, created: SnapshotMetadata): Promise<void> {
  try {
    await runtime.uploader.upload(created);
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
 * Purges every snapshot in the directory by invoking `applyRetentionPlan`
 * with a keep-nothing policy. Used by the v0.2.0 `ConsentService.clear`
 * listener because we cannot inspect encrypted bytes to know which
 * snapshots contain the revoked subject.
 *
 * `applyRetentionPlan` is signature-async; the body does no I/O awaits
 * but we await the returned promise to honour the contract. Any leftover
 * files (e.g. permission denied) are surfaced back through the thrown
 * `Error`.
 *
 * Exported so the privacy-clear test can assert the wire-up without
 * running the full scheduler loop.
 */
export async function purgeAllSnapshots(options: {
  snapshotDir: string;
  encryptionKey: string | undefined;
  clock?: () => Date;
}): Promise<void> {
  const snapshots = listSnapshots(options.snapshotDir, options.encryptionKey);
  if (snapshots.length === 0) {
    return;
  }
  const clock = options.clock ?? (() => new Date());
  // planRetention only needs createdAt + path; listSnapshots already decoded
  // the encrypted metadata, so the real timestamps are available.
  const plan = planRetention(
    snapshots,
    {
      dailyRetention: 0,
      monthlyRetention: 0,
      weeklyRetention: 0,
    },
    clock(),
  );
  await applyRetentionPlan(plan);
  const remaining = listSnapshots(options.snapshotDir, options.encryptionKey);
  if (remaining.length > 0) {
    throw new Error(`failed to purge ${remaining.length} snapshot file(s)`);
  }
}

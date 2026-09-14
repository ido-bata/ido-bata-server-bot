import type { Client } from "discord.js";
import { Events } from "discord.js";

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

type SnapshotDependencies = {
  encryptionKey?: string;
  runOnReady?: boolean;
  clock?: () => Date;
  uploader?: SnapshotUploader;
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
): { cancel: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let cancelled = false;

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
    console.log(
      `[StateSnapshot] Next snapshot scheduled for ${nextStartAt.toISOString()} (in ${Math.round(delayMs / 1000)}s)`,
    );

    timer = setTimeout(() => {
      void runSnapshotOnce(runtime)
        .catch((error: unknown) => {
          console.error("[StateSnapshot] Scheduled snapshot failed", error);
        })
        .finally(() => {
          schedule();
        });
    }, delayMs);
  };

  client.once(Events.ClientReady, () => {
    if (runtime.runOnReady) {
      console.log("[StateSnapshot] Running immediately because STATE_SNAPSHOT_RUN_ON_READY=true");
      void runSnapshotOnce(runtime).catch((error: unknown) => {
        console.error("[StateSnapshot] Immediate snapshot failed", error);
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
    console.error(
      `[StateSnapshot] Uploader "${runtime.uploader.name}" failed for ${created.path}`,
      error,
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

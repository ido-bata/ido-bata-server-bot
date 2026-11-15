import "dotenv/config";

import { resolve } from "node:path";

import { restoreSnapshot } from "../features/state-snapshot/snapshot.js";
import { childFor, createRootLogger, getRootLogger } from "../lib/logger/index.js";
import { getStorageDriver } from "../lib/storage/index.js";

type CliOptions = {
  outputDir: string;
  snapshot: string;
};

const SNAPSHOT_PREFIX = "snapshots";

function printUsage(): void {
  console.log(
    [
      "Usage: tsx src/scripts/restore-snapshot.ts --snapshot <snapshot-key> [--output <dir>]",
      "",
      "The snapshot is read from the configured storage backend",
      "(STORAGE_BACKEND=local reads <data>/<key>, STORAGE_BACKEND=u3 reads the bucket).",
      "Pass a full key (e.g. snapshots/20260401-030000.snap.enc) or a bare id —",
      "the newest snapshot is used when the id does not resolve to an object.",
      "",
      "Environment:",
      "  STATE_SNAPSHOT_ENCRYPTION_KEY   hex-encoded 32-byte AES-256 key",
      "",
      "Examples:",
      "  tsx src/scripts/restore-snapshot.ts --snapshot 20260401-030000 --output data/restore",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliOptions {
  let snapshot: string | undefined;
  let outputDir = "data/restore";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--snapshot" || arg === "-s") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--snapshot requires a key");
      }
      snapshot = next;
      index += 1;
    } else if (arg === "--output" || arg === "-o") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--output requires a path");
      }
      outputDir = next;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!snapshot) {
    throw new Error("--snapshot <snapshot-key> is required");
  }

  return { outputDir, snapshot };
}

/**
 * Resolve the snapshot object key. A key that contains a separator is used
 * as-is; a bare id falls back to the newest snapshot in the prefix (the
 * ids sort lexicographically in creation order).
 */
async function resolveSnapshotKey(snapshotArg: string): Promise<string> {
  const driver = getStorageDriver();
  if (snapshotArg.includes("/")) {
    return snapshotArg;
  }
  const entries = await driver.list(`${SNAPSHOT_PREFIX}/`);
  const candidates = entries
    .map((entry) => entry.key)
    .filter((key) => key.endsWith(".snap.enc"))
    .filter((key) => key.includes(snapshotArg));
  if (candidates.length === 0) {
    throw new Error(`No snapshots found for selector: ${snapshotArg}`);
  }
  return candidates.sort().reverse()[0]!;
}

async function main(): Promise<void> {
  createRootLogger({ ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? "info" });
  const logger = childFor(getRootLogger(), "restore-snapshot");

  const options = parseArgs(process.argv.slice(2));
  const encryptionKey = process.env.STATE_SNAPSHOT_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error(
      "STATE_SNAPSHOT_ENCRYPTION_KEY must be set in the environment (hex-encoded 32-byte key).",
    );
  }

  const snapshotKey = await resolveSnapshotKey(options.snapshot);
  logger.info({ snapshotKey }, "restoring snapshot");
  const result = await restoreSnapshot(snapshotKey, encryptionKey, {
    driver: getStorageDriver(),
    outputDir: resolve(options.outputDir),
  });
  logger.info(
    {
      filesRestored: result.files.length,
      outputDir: options.outputDir,
      createdAt: result.manifest.createdAt,
    },
    "snapshot restored",
  );
}

main().catch((error: unknown) => {
  childFor(getRootLogger(), "restore-snapshot").error({ err: error }, "restore failed");
  process.exitCode = 1;
});

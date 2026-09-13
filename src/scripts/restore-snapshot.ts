import "dotenv/config";

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { restoreSnapshot } from "../features/state-snapshot/snapshot.js";

type CliOptions = {
  outputDir: string;
  snapshot: string;
};

function printUsage(): void {
  console.log(
    [
      "Usage: tsx src/scripts/restore-snapshot.ts --snapshot <path-to-snap.enc> [--output <dir>]",
      "",
      "Environment:",
      "  STATE_SNAPSHOT_ENCRYPTION_KEY   hex-encoded 32-byte AES-256 key",
      "",
      "Examples:",
      "  tsx src/scripts/restore-snapshot.ts --snapshot data/snapshots/20260401-030000.snap.enc --output data/restore",
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
        throw new Error("--snapshot requires a path");
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
    throw new Error("--snapshot <path-to-snap.enc> is required");
  }

  return { outputDir, snapshot };
}

function resolveSnapshotPath(snapshotArg: string): string {
  const candidates: string[] = [];
  if (snapshotArg.includes("/") || snapshotArg.includes("\\")) {
    candidates.push(resolve(snapshotArg));
  } else {
    const snapshotDir = resolve("data/snapshots");
    for (const name of readdirSync(snapshotDir)) {
      if (!name.endsWith(".snap.enc")) {
        continue;
      }
      const fullPath = join(snapshotDir, name);
      if (!statSync(fullPath).isFile()) {
        continue;
      }
      candidates.push(fullPath);
    }
  }
  if (candidates.length === 0) {
    throw new Error(`No snapshots found for selector: ${snapshotArg}`);
  }
  if (candidates.length === 1) {
    return candidates[0]!;
  }
  // If snapshot arg matches a full path, prefer it; otherwise pick the latest
  // snapshot by file name (lexicographic order approximates creation time).
  if (candidates.includes(resolve(snapshotArg))) {
    return resolve(snapshotArg);
  }
  return candidates.sort().reverse()[0]!;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const encryptionKey = process.env.STATE_SNAPSHOT_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error(
      "STATE_SNAPSHOT_ENCRYPTION_KEY must be set in the environment (hex-encoded 32-byte key).",
    );
  }

  const snapshotPath = resolveSnapshotPath(options.snapshot);
  console.log(`Restoring snapshot: ${snapshotPath}`);
  const result = await restoreSnapshot(snapshotPath, encryptionKey, {
    outputDir: options.outputDir,
  });
  console.log(
    [
      `Restored ${result.files.length} file(s) to ${options.outputDir}`,
      `Created at: ${result.manifest.createdAt}`,
      "Files:",
      ...result.files.map(
        (file) =>
          `  - ${file.path}  (${file.size} bytes, sha256=${file.sha256.slice(0, 12)}...)`,
      ),
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  console.error("Restore failed:", error);
  process.exitCode = 1;
});
/**
 * Storage migration tool — moves the bot's persisted state between a local
 * `data/` directory and the configured storage backend (ADR-0004).
 *
 *   # 1. Export the current host's data directory (manifest + files + sha256)
 *   bun run storage:migrate -- export --out ./migration-export
 *
 *   # 2. Import the export into the configured backend (STORAGE_BACKEND=u3)
 *   STORAGE_BACKEND=u3 S3_BUCKET=… AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
 *     bun run storage:migrate -- import --from ./migration-export
 *
 *   # 3. Verify the backend against the export (counts + sha256)
 *   STORAGE_BACKEND=u3 … bun run storage:migrate -- verify --from ./migration-export
 *
 * The tool never deletes the source: the export directory and the old
 * host's `data/` stay untouched (Issue #121 requires the old data to
 * survive the migration).
 */
import "dotenv/config";

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DELETION_LEDGER_KEY,
  type DeletionLedger,
  mergeDeletionLedgers,
  readDeletionLedger,
} from "../lib/storage/deletions.js";
import { applyDeletionLedger } from "../lib/storage/erasure.js";
import { createStorageDriver } from "../lib/storage/index.js";
import { createLocalFileStorage } from "../lib/storage/local.js";
import type { StorageDriver } from "../lib/storage/types.js";

const MANIFEST_NAME = "manifest.json";
const MANIFEST_SCHEMA_VERSION = 1;

export type ManifestEntry = {
  key: string;
  size: number;
  sha256: string;
};

export type StorageManifest = {
  schemaVersion: number;
  exportedAt: string;
  entries: ManifestEntry[];
};

export type MigrationReport = {
  exported: number;
  imported: number;
  verified: number;
  missing: string[];
  mismatched: string[];
  extra: string[];
  /** Subjects whose data was removed again while restoring (deletion ledger). */
  erasedSubjects: string[];
  /** Objects rewritten because a recorded deletion was re-applied. */
  rewrittenObjects: string[];
};

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Copy every object of `source` into `outDir` and write the manifest. */
export async function exportStorage(options: {
  source: StorageDriver;
  outDir: string;
}): Promise<StorageManifest> {
  const { source, outDir } = options;
  const keys = (await source.list("")).map((entry) => entry.key);
  const entries: ManifestEntry[] = [];

  for (const key of keys) {
    const bytes = await source.read(key);
    if (bytes === null) {
      continue;
    }
    const target = join(outDir, key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    entries.push({ key, sha256: sha256Hex(bytes), size: bytes.length });
  }

  const manifest: StorageManifest = {
    entries,
    exportedAt: new Date().toISOString(),
    schemaVersion: MANIFEST_SCHEMA_VERSION,
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

/** Parse a deletion ledger from raw bytes. */
function parseLedger(bytes: Uint8Array): DeletionLedger {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<DeletionLedger>;
    return {
      records: Array.isArray(parsed.records) ? parsed.records : [],
      schemaVersion: 1,
    };
  } catch {
    return { records: [], schemaVersion: 1 };
  }
}

/** Read an export manifest from disk. */
export async function readManifest(dir: string): Promise<StorageManifest> {
  const raw = await readFile(join(dir, MANIFEST_NAME), "utf8");
  const parsed = JSON.parse(raw) as StorageManifest;
  if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`unsupported manifest schema version: ${parsed.schemaVersion}`);
  }
  return parsed;
}

/**
 * Upload an export into the target backend. Every object is verified
 * against the manifest checksum before the upload and read back afterwards,
 * so a truncated or corrupted transfer fails loudly.
 */
export async function importStorage(options: {
  target: StorageDriver;
  dir: string;
  allowOverwrite: boolean;
}): Promise<MigrationReport> {
  const { target, dir, allowOverwrite } = options;
  const manifest = await readManifest(dir);
  const report: MigrationReport = {
    erasedSubjects: [],
    exported: 0,
    extra: [],
    imported: 0,
    mismatched: [],
    missing: [],
    rewrittenObjects: [],
    verified: 0,
  };

  // The deletion ledger is append-only. Capture the live ledger before the
  // import so a restore can never roll the erasure history back.
  const liveLedger = await readDeletionLedger(target);
  let importedLedger = liveLedger;

  for (const entry of manifest.entries) {
    const bytes = await readFile(join(dir, entry.key));
    const actual = sha256Hex(bytes);
    if (actual !== entry.sha256) {
      throw new Error(
        `export file checksum mismatch for ${entry.key} (expected ${entry.sha256}, got ${actual})`,
      );
    }
    if (!allowOverwrite && (await target.exists(entry.key))) {
      throw new Error(
        `target already holds ${entry.key}; re-run with --allow-overwrite to replace it`,
      );
    }
    if (entry.key === DELETION_LEDGER_KEY) {
      // Merge instead of replacing: a restore must not drop the deletion
      // records the live store already knows about.
      importedLedger = mergeDeletionLedgers(liveLedger, parseLedger(bytes));
      continue;
    }
    await target.write(entry.key, bytes);
    const written = await target.read(entry.key);
    if (written === null || sha256Hex(written) !== entry.sha256) {
      throw new Error(`verification failed after writing ${entry.key}`);
    }
    report.imported += 1;
    report.verified += 1;
  }

  if (importedLedger.records.length !== liveLedger.records.length) {
    await target.write(DELETION_LEDGER_KEY, `${JSON.stringify(importedLedger, null, 2)}\n`);
  }

  // Re-apply the recorded erasures: a backup taken before a
  // `/privacy delete` still contains the subject.
  const ledgerKey = process.env.DELETION_LEDGER_KEY;
  if (ledgerKey) {
    const erasure = await applyDeletionLedger(target, ledgerKey);
    report.erasedSubjects = erasure.removedSubjects;
    report.rewrittenObjects = erasure.rewrittenObjects;
  } else {
    console.warn(
      "storage-migrate: DELETION_LEDGER_KEY is not configured; restored data may contain subjects deleted after the backup was taken",
    );
  }

  return report;
}

/** Compare the target backend against an export manifest. */
export async function verifyStorage(options: {
  target: StorageDriver;
  dir: string;
}): Promise<MigrationReport> {
  const { target, dir } = options;
  const manifest = await readManifest(dir);
  const report: MigrationReport = {
    erasedSubjects: [],
    exported: 0,
    extra: [],
    imported: 0,
    mismatched: [],
    missing: [],
    rewrittenObjects: [],
    verified: 0,
  };

  const expected = new Map(manifest.entries.map((entry) => [entry.key, entry]));
  const actualKeys = new Set((await target.list("")).map((entry) => entry.key));

  for (const entry of manifest.entries) {
    if (!actualKeys.has(entry.key)) {
      report.missing.push(entry.key);
      continue;
    }
    const bytes = await target.read(entry.key);
    if (bytes === null) {
      report.missing.push(entry.key);
      continue;
    }
    const actual = sha256Hex(bytes);
    if (actual !== entry.sha256 || bytes.length !== entry.size) {
      report.mismatched.push(entry.key);
      continue;
    }
    report.verified += 1;
  }

  for (const key of actualKeys) {
    if (!expected.has(key)) {
      report.extra.push(key);
    }
  }

  return report;
}

type CliOptions = {
  command: "export" | "import" | "verify";
  dir?: string;
  out?: string;
  allowOverwrite: boolean;
  sourceDir: string;
};

function parseArgs(argv: string[]): CliOptions {
  const command = argv[0];
  if (command !== "export" && command !== "import" && command !== "verify") {
    throw new Error("usage: storage-migrate <export|import|verify> [--out <dir>] [--from <dir>]");
  }
  let dir: string | undefined;
  let out: string | undefined;
  let allowOverwrite = false;
  let sourceDir = resolve(process.cwd(), "data");

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--out" && value) {
      out = value;
      index += 1;
    } else if (arg === "--from" && value) {
      dir = value;
      index += 1;
    } else if (arg === "--source-dir" && value) {
      sourceDir = resolve(value);
      index += 1;
    } else if (arg === "--allow-overwrite") {
      allowOverwrite = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { allowOverwrite, command, dir, out, sourceDir };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const target = createStorageDriver();

  if (options.command === "export") {
    const outDir = resolve(options.out ?? "migration-export");
    const manifest = await exportStorage({
      outDir,
      source: createLocalFileStorage({ root: options.sourceDir }),
    });
    console.log(
      `exported ${manifest.entries.length} object(s) to ${outDir} (manifest: ${join(outDir, MANIFEST_NAME)})`,
    );
    for (const entry of manifest.entries) {
      console.log(`  ${entry.key} ${entry.size} B sha256=${entry.sha256}`);
    }
    return;
  }

  const dir = resolve(options.dir ?? "migration-export");
  if (options.command === "import") {
    const report = await importStorage({ allowOverwrite: options.allowOverwrite, dir, target });
    console.log(
      `imported ${report.imported} object(s) into the ${target.kind} backend (${report.verified} verified)`,
    );
    if (report.erasedSubjects.length > 0) {
      console.log(
        `re-applied ${report.erasedSubjects.length} recorded deletion(s): ${report.erasedSubjects.join(", ")}`,
      );
      console.log(`rewritten objects: ${report.rewrittenObjects.join(", ") || "(none)"}`);
    }
    return;
  }

  const report = await verifyStorage({ dir, target });
  console.log(
    `verify: ${report.verified} matched, ${report.missing.length} missing, ${report.mismatched.length} mismatched, ${report.extra.length} unexpected`,
  );
  for (const key of report.missing) {
    console.log(`  missing: ${key}`);
  }
  for (const key of report.mismatched) {
    console.log(`  mismatched: ${key}`);
  }
  for (const key of report.extra) {
    console.log(`  unexpected: ${key}`);
  }
  if (report.missing.length > 0 || report.mismatched.length > 0) {
    process.exitCode = 1;
  }
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  main().catch((error: unknown) => {
    console.error(`storage-migrate failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}

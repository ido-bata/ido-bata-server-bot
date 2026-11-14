/**
 * Storage migration tool — moves the bot's persisted state between the
 * local `data/` directory and the configured storage backend (ADR-0004).
 *
 *   # 1. Export the old host's data directory (manifest + files + sha256)
 *   bun run storage:migrate -- export --source local --source-dir ./data \
 *     --out ./migration-export
 *
 *   # 2. Import the export into the configured backend (STORAGE_BACKEND=u3)
 *   STORAGE_BACKEND=u3 S3_BUCKET=… AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
 *     bun run storage:migrate -- import --from ./migration-export
 *
 *   # 3. Verify the backend against the export (counts + sha256)
 *   STORAGE_BACKEND=u3 … bun run storage:migrate -- verify --from ./migration-export
 *
 *   # Backup: copy the configured bucket into a second bucket and verify
 *   # the copy. One command, so the verification always runs against the
 *   # bucket that was actually written.
 *   S3_BUCKET=ido-bata-bot … bun run storage:migrate -- backup \
 *     --target-bucket ido-bata-bot-backup --out ./backups/$(date +%F)
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
  digestSubjectId,
  mergeDeletionLedgers,
  readDeletionLedgerState,
} from "../lib/storage/deletions.js";
import {
  applyDeletionLedger,
  applyErasuresToValue,
  collectSubjectIds,
} from "../lib/storage/erasure.js";
import { createStorageDriver } from "../lib/storage/index.js";
import { createLocalFileStorage } from "../lib/storage/local.js";
import type { StorageDriver } from "../lib/storage/types.js";
import { createU3Storage } from "../lib/storage/u3.js";

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
  /** Objects that match the manifest only after the erasure was re-applied. */
  erasureAdjusted: string[];
  /** Ledger state observed in the target: ok / missing / corrupt. */
  ledgerStatus: "ok" | "missing" | "corrupt";
};

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

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
    // The manifest is the export's own bookkeeping, never data. Copying it
    // would make an export of an export directory rewrite its own manifest
    // and then fail its own checksum comparison.
    if (key === MANIFEST_NAME) {
      continue;
    }
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
  /** Allow a restore without `DELETION_LEDGER_KEY` (explicit override). */
  allowMissingLedger?: boolean;
}): Promise<MigrationReport> {
  const { target, dir, allowOverwrite } = options;
  const manifest = await readManifest(dir);
  const report: MigrationReport = {
    erasedSubjects: [],
    erasureAdjusted: [],
    exported: 0,
    extra: [],
    imported: 0,
    ledgerStatus: "missing",
    mismatched: [],
    missing: [],
    rewrittenObjects: [],
    verified: 0,
  };

  const ledgerKey = options.allowMissingLedger
    ? (process.env.DELETION_LEDGER_KEY ?? "")
    : process.env.DELETION_LEDGER_KEY;
  if (!ledgerKey) {
    // Fail closed: without the key the recorded erasures cannot be
    // matched, so a restore could resurrect data a user asked to forget.
    if (!options.allowMissingLedger) {
      throw new Error(
        "DELETION_LEDGER_KEY is not configured; refusing to restore data that may contain deleted subjects. " +
          "Set the key, or pass --allow-missing-deletion-ledger to accept the risk explicitly.",
      );
    }
    console.warn(
      "storage-migrate: DELETION_LEDGER_KEY is not configured; the restored data may contain subjects deleted after the backup was taken",
    );
  }

  // The deletion ledger is append-only. Read the live ledger *before* the
  // import so a restore can never roll the erasure history back, and
  // refuse to continue when the live ledger is damaged.
  const liveState = await readDeletionLedgerState(target);
  if (liveState.status === "corrupt") {
    throw new Error(liveState.error);
  }
  report.ledgerStatus = liveState.status;
  const liveLedger: DeletionLedger =
    liveState.status === "ok" ? liveState.ledger : { records: [], schemaVersion: 1 };
  let importedLedger = liveLedger;

  for (const entry of manifest.entries) {
    if (entry.key === MANIFEST_NAME) {
      continue;
    }
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

  // The live ledger must not be *shorter* than the backup's: a truncated
  // erasure history means deletion records were lost, and a restore would
  // then be able to resurrect those subjects.
  const liveDigests = new Set(liveLedger.records.map((record) => record.digest));
  const lostRecords = importedLedger.records.filter(
    (record) => !liveDigests.has(record.digest) && liveState.status === "ok",
  );
  if (liveState.status === "ok" && lostRecords.length > 0) {
    throw new Error(
      `the live deletion ledger lost ${lostRecords.length} record(s) that the backup still has; ` +
        "refusing to restore — the erasure history is incomplete",
    );
  }

  if (importedLedger.records.length !== liveLedger.records.length) {
    await target.write(DELETION_LEDGER_KEY, `${JSON.stringify(importedLedger, null, 2)}\n`);
  }

  // Re-apply the recorded erasures: a backup taken before a
  // `/privacy delete` still contains the subject.
  if (ledgerKey) {
    const erasure = await applyDeletionLedger(target, ledgerKey);
    report.erasedSubjects = erasure.removedSubjects;
    report.rewrittenObjects = erasure.rewrittenObjects;
  }

  return report;
}

/**
 * Copy the source backend into a target bucket and verify the copy.
 *
 * One command on purpose: the verification must run against the bucket
 * that was actually written, otherwise an operator can verify the wrong
 * bucket and call it a backup. The import overwrites the previous copy —
 * a backup is a copy, not an append — so the command is repeatable.
 */
export async function backupStorage(options: {
  source: StorageDriver;
  target: StorageDriver;
  exportDir: string;
  allowMissingLedger?: boolean;
}): Promise<MigrationReport> {
  const manifest = await exportStorage({ outDir: options.exportDir, source: options.source });
  const report = await importStorage({
    allowMissingLedger: options.allowMissingLedger,
    allowOverwrite: true,
    dir: options.exportDir,
    target: options.target,
  });
  const verification = await verifyStorage({
    dir: options.exportDir,
    target: options.target,
  });
  report.erasureAdjusted = verification.erasureAdjusted;
  report.extra = verification.extra;
  report.mismatched = verification.mismatched;
  report.missing = verification.missing;
  report.verified = verification.verified;
  if (verification.missing.length > 0 || verification.mismatched.length > 0) {
    throw new Error(
      `backup verification failed: ${verification.missing.length} missing, ${verification.mismatched.length} mismatched`,
    );
  }
  report.exported = manifest.entries.length;
  return report;
}

/**
 * Compare the target backend against an export manifest.
 *
 * The comparison is *erasure aware*: when the restore re-applied a
 * recorded deletion, the restored object legitimately differs from the
 * backup. Such an object is verified against the state the erasure must
 * produce, not against the raw backup bytes — otherwise a correct final
 * state would be reported as a checksum mismatch.
 */
export async function verifyStorage(options: {
  target: StorageDriver;
  dir: string;
  /** Ledger key. Without it the comparison is a plain byte comparison. */
  ledgerKey?: string;
}): Promise<MigrationReport> {
  const { target, dir } = options;
  const manifest = await readManifest(dir);
  const report: MigrationReport = {
    erasedSubjects: [],
    erasureAdjusted: [],
    exported: 0,
    extra: [],
    imported: 0,
    ledgerStatus: "missing",
    mismatched: [],
    missing: [],
    rewrittenObjects: [],
    verified: 0,
  };

  const ledgerKey = options.ledgerKey ?? process.env.DELETION_LEDGER_KEY;
  const erasedSubjects = ledgerKey ? await erasedSubjectIds(target, dir, manifest, ledgerKey) : [];

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
    if (actual === entry.sha256 && bytes.length === entry.size) {
      report.verified += 1;
      continue;
    }
    // The object differs. It is still correct when the difference is
    // exactly the recorded erasure that the restore re-applied.
    if (
      erasedSubjects.length > 0 &&
      (await matchesErasureAdjustedState(dir, entry, bytes, erasedSubjects))
    ) {
      report.erasureAdjusted.push(entry.key);
      report.verified += 1;
      continue;
    }
    report.mismatched.push(entry.key);
  }

  for (const key of actualKeys) {
    if (!expected.has(key)) {
      report.extra.push(key);
    }
  }

  return report;
}

/**
 * The subject ids that the ledger records as deleted and that appear in
 * the exported objects.
 */
async function erasedSubjectIds(
  target: StorageDriver,
  dir: string,
  manifest: StorageManifest,
  ledgerKey: string,
): Promise<string[]> {
  const state = await readDeletionLedgerState(target);
  if (state.status !== "ok") {
    return [];
  }
  const digests = new Set(state.ledger.records.map((record) => record.digest));
  const candidates = new Set<string>();
  for (const entry of manifest.entries) {
    const bytes = await readFile(join(dir, entry.key)).catch(() => null);
    if (!bytes) {
      continue;
    }
    collectSubjectIds(parseJson(new TextDecoder().decode(bytes)), candidates);
  }
  return [...candidates].filter((candidate) => digests.has(digestSubjectId(candidate, ledgerKey)));
}

/**
 * Whether the target object is exactly the backup object with the
 * recorded erasures applied. A restore that re-applied a deletion must
 * not be reported as a checksum mismatch.
 */
async function matchesErasureAdjustedState(
  dir: string,
  entry: ManifestEntry,
  targetBytes: Uint8Array,
  erasedSubjects: readonly string[],
): Promise<boolean> {
  const source = await readFile(join(dir, entry.key)).catch(() => null);
  if (!source) {
    return false;
  }
  const outcome = applyErasuresToValue(parseJson(new TextDecoder().decode(source)), erasedSubjects);
  if (!outcome.changed) {
    return false;
  }
  const expected = Buffer.from(`${JSON.stringify(outcome.value, null, 2)}\n`, "utf8");
  return sha256Hex(expected) === sha256Hex(targetBytes);
}

type CliOptions = {
  command: "export" | "import" | "verify" | "backup";
  dir?: string;
  out?: string;
  allowOverwrite: boolean;
  allowMissingLedger: boolean;
  source: "configured" | "local";
  sourceDir: string;
  targetBucket?: string;
  targetDir?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const command = argv[0];
  if (
    command !== "export" &&
    command !== "import" &&
    command !== "verify" &&
    command !== "backup"
  ) {
    throw new Error(
      "usage: storage-migrate <export|import|verify|backup> [--out <dir>] [--from <dir>] " +
        "[--source local|u3] [--source-dir <dir>] [--target-bucket <name>] [--target-dir <dir>] " +
        "[--allow-overwrite] [--allow-missing-deletion-ledger]",
    );
  }
  let dir: string | undefined;
  let out: string | undefined;
  let allowOverwrite = false;
  let allowMissingLedger = false;
  let source: CliOptions["source"] = "configured";
  let sourceDir = resolve(process.cwd(), "data");
  let targetBucket: string | undefined;
  let targetDir: string | undefined;

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
    } else if (arg === "--source" && value) {
      if (value === "u3") {
        source = "configured";
      } else if (value === "local" || value === "configured") {
        source = value;
      } else {
        throw new Error(`--source must be "local", "u3" or "configured" (got ${value})`);
      }
      index += 1;
    } else if (arg === "--target-bucket" && value) {
      targetBucket = value;
      index += 1;
    } else if (arg === "--target-dir" && value) {
      targetDir = resolve(value);
      index += 1;
    } else if (arg === "--allow-overwrite") {
      allowOverwrite = true;
    } else if (arg === "--allow-missing-deletion-ledger") {
      allowMissingLedger = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return {
    allowMissingLedger,
    allowOverwrite,
    command,
    dir,
    out,
    source,
    sourceDir,
    targetBucket,
    targetDir,
  };
}

/**
 * The driver the command reads from. `--source local` reads the old
 * host's data directory; everything else reads the configured backend, so
 * "export the primary bucket" works without a local copy.
 */
function resolveSourceDriver(options: CliOptions): StorageDriver {
  if (options.source === "local") {
    return createLocalFileStorage({ root: options.sourceDir });
  }
  return createStorageDriver();
}

/**
 * The driver the backup is written to. The bucket is explicit so the
 * verification can never run against a different bucket than the one that
 * was written.
 */
function resolveTargetDriver(options: CliOptions): StorageDriver {
  if (!options.targetBucket) {
    if (options.targetDir) {
      // A local target keeps the command executable (and testable) without
      // bucket credentials.
      return createLocalFileStorage({ root: options.targetDir });
    }
    throw new Error(
      "--target-bucket <name> (or --target-dir <dir>) is required: the backup target must be explicit so the verification runs against the bucket that was written",
    );
  }
  const env = process.env;
  const endpoint = env.BACKUP_S3_ENDPOINT ?? env.S3_ENDPOINT ?? env.U3_ENDPOINT;
  const region = env.BACKUP_S3_REGION ?? env.S3_REGION ?? env.U3_REGION;
  const accessKeyId = env.BACKUP_AWS_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID ?? env.U3_ACCESS_KEY_ID;
  const secretAccessKey =
    env.BACKUP_AWS_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY ?? env.U3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "the backup target needs credentials (BACKUP_AWS_ACCESS_KEY_ID / BACKUP_AWS_SECRET_ACCESS_KEY or the S3_* fallbacks)",
    );
  }
  return createU3Storage({
    accessKeyId,
    bucket: options.targetBucket,
    endpoint,
    forcePathStyle: true,
    region,
    secretAccessKey,
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "export") {
    const outDir = resolve(options.out ?? "migration-export");
    const manifest = await exportStorage({ outDir, source: resolveSourceDriver(options) });
    console.log(
      `exported ${manifest.entries.length} object(s) to ${outDir} (manifest: ${join(outDir, MANIFEST_NAME)})`,
    );
    for (const entry of manifest.entries) {
      console.log(`  ${entry.key} ${entry.size} B sha256=${entry.sha256}`);
    }
    return;
  }

  if (options.command === "backup") {
    const outDir = resolve(options.out ?? `backups/${new Date().toISOString().slice(0, 19)}`);
    const report = await backupStorage({
      allowMissingLedger: options.allowMissingLedger,
      exportDir: outDir,
      source: resolveSourceDriver(options),
      target: resolveTargetDriver(options),
    });
    console.log(
      `backed up ${report.exported} object(s) to ${options.targetBucket ?? options.targetDir} (${report.verified} verified, ${report.erasureAdjusted.length} erasure-adjusted)`,
    );
    return;
  }

  const target = createStorageDriver();
  const dir = resolve(options.dir ?? "migration-export");

  if (options.command === "import") {
    const report = await importStorage({
      allowMissingLedger: options.allowMissingLedger,
      allowOverwrite: options.allowOverwrite,
      dir,
      target,
    });
    console.log(
      `imported ${report.imported} object(s) into the ${target.kind} backend (${report.verified} verified, ledger: ${report.ledgerStatus})`,
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
    `verify: ${report.verified} matched (${report.erasureAdjusted.length} erasure-adjusted), ${report.missing.length} missing, ${report.mismatched.length} mismatched, ${report.extra.length} unexpected`,
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

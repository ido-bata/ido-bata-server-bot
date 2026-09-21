import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";
import type { ConsentRepository } from "./repository.js";
import { CONSENT_SCOPES, type ConsentScope } from "./scopes.js";
import type { ConsentRecord, ConsentSource } from "./types.js";

const CURRENT_SCHEMA_VERSION = 1 as const;

const consentSourceSchema = z.object({
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  messageId: z.string().min(1),
  emoji: z.string().min(1),
}) satisfies z.ZodType<ConsentSource>;

const consentRecordSchema = z.object({
  subjectId: z.string().min(1),
  scope: z.enum(CONSENT_SCOPES),
  policyVersion: z.string().min(1),
  grantedAt: z.string().min(1),
  revokedAt: z.string().nullable(),
  source: consentSourceSchema,
}) satisfies z.ZodType<ConsentRecord>;

const storeSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  records: z.array(consentRecordSchema),
});

export type JsonConsentRepositoryOptions = {
  /**
   * Override the JSON file path. Tests inject a temp file here. Defaults
   * to `<cwd>/data/consent.json`.
   */
  filePath?: string;
};

type LoadedFile = {
  records: ConsentRecord[];
  /**
   * `true` only when the on-disk file existed and we successfully parsed
   * it. `false` covers both "fresh start — no file" (writes are fine) and
   * "file exists but failed validation" (writes must refuse to clobber
   * the backup). The two cases are distinguished by `existed`.
   */
  recognised: boolean;
  /** Did a file exist on disk before this load attempt? */
  existed: boolean;
};

function loadFromDisk(filePath: string): LoadedFile {
  if (!existsSync(filePath)) {
    return { records: [], recognised: false, existed: false };
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    // Unreadable file is treated as empty so a corrupted/missing file never
    // crashes the service. Operators can investigate via filesystem logs.
    return { records: [], recognised: false, existed: true };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Corrupt JSON → empty store. Same fail-open-for-read principle as
    // `features/ical-calendar/cache.ts`.
    return { records: [], recognised: false, existed: true };
  }

  const parsed = storeSchema.safeParse(payload);
  if (!parsed.success) {
    // The on-disk file failed schema validation (future `schemaVersion`
    // bump, partial write, unexpected shape). Preserve the bytes so an
    // operator can recover, and flag the cache so subsequent persists
    // refuse to clobber them — silent data loss is unacceptable for a
    // privacy SoT.
    try {
      renameSync(filePath, `${filePath}.unrecognised-${Date.now()}.bak`);
    } catch {
      // best-effort backup; fall through with the empty cache + recognised=false
    }
    return { records: [], recognised: false, existed: true };
  }

  return { records: parsed.data.records, recognised: true, existed: true };
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Write `payload` to `filePath` atomically. The write goes to a uniquely
 * named `<path>.tmp-<rand>` file using `O_EXCL`, then `rename(2)` swaps it
 * into place. If the rename fails, the temp file is removed before the
 * error propagates — disk-full / permission errors surface to the caller.
 *
 * The PID + random suffix lets concurrent writers (e.g. two reaction
 * events racing) avoid stomping on each other's temp files. PID is part
 * of the suffix to make debugging easier when a stale temp is found.
 */
function atomicWriteJson(filePath: string, payload: unknown): void {
  const tempPath = `${filePath}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(tempPath, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export type JsonConsentRepository = ConsentRepository & {
  /** Resolved file path. Useful for diagnostics + tests. */
  readonly filePath: string;
};

export function createJsonConsentRepository(
  options: JsonConsentRepositoryOptions = {},
): JsonConsentRepository {
  const filePath = options.filePath ?? `${process.cwd()}/data/consent.json`;

  // Cache records in memory; persist on every mutation. `load()` re-reads
  // from disk so a fresh process picks up the latest persisted state.
  let records: ConsentRecord[] = [];
  // `true` means writes are allowed. Defaults to `true` so a brand-new
  // repository (or a repository the caller never called `load()` on)
  // can persist immediately. `load()` flips it to `false` only when an
  // existing on-disk file failed schema validation — in that case
  // mutations refuse to clobber the backup that `loadFromDisk` left
  // next to the original path. A fresh "file does not exist" load does
  // NOT flip the flag (the file isn't there to be clobbered).
  let lastLoadRecognised = true;
  // Tracks whether the most recent `load()` actually read a file off
  // disk. Used to disambiguate "fresh start" from "existing unreadable
  // file" in the silent-data-loss unit test.
  let lastLoadExisted = false;

  async function load(): Promise<ConsentRecord[]> {
    const result = loadFromDisk(filePath);
    records = [...result.records];
    lastLoadExisted = result.existed;
    lastLoadRecognised = result.recognised;
    return [...records];
  }

  async function persist(next: ConsentRecord[]): Promise<void> {
    if (lastLoadExisted && !lastLoadRecognised) {
      // The most recent disk read failed schema validation; the original
      // bytes have been renamed to `<file>.unrecognised-<ts>.bak`. Refuse
      // to write — an operator must either inspect the backup or rotate
      // to a known-good file before persistence can resume.
      throw new Error(
        `consent repository: refusing to persist after unrecognised disk read at ${filePath} ` +
          `(a backup was preserved alongside the original file)`,
      );
    }
    ensureDir(filePath);
    atomicWriteJson(filePath, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      records: next,
    });
    records = [...next];
    lastLoadExisted = true;
    lastLoadRecognised = true;
  }

  function findIndex(subjectId: string, scope: ConsentScope): number {
    return records.findIndex((record) => record.subjectId === subjectId && record.scope === scope);
  }

  async function save(next: ConsentRecord[]): Promise<void> {
    await persist(next);
  }

  async function upsert(record: ConsentRecord): Promise<void> {
    const next = [...records];
    const index = next.findIndex(
      (existing) => existing.subjectId === record.subjectId && existing.scope === record.scope,
    );
    if (index >= 0) {
      next[index] = record;
    } else {
      next.push(record);
    }
    await persist(next);
  }

  async function remove(subjectId: string, scope: ConsentScope): Promise<boolean> {
    const index = findIndex(subjectId, scope);
    if (index < 0) {
      return false;
    }
    const next = [...records];
    next.splice(index, 1);
    await persist(next);
    return true;
  }

  async function clearSubject(subjectId: string): Promise<void> {
    const next = records.filter((record) => record.subjectId !== subjectId);
    if (next.length === records.length) {
      return;
    }
    await persist(next);
  }

  return {
    filePath,
    load,
    save,
    upsert,
    remove,
    clearSubject,
  };
}

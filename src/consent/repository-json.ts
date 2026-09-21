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

import { CONSENT_SCOPES, type ConsentScope } from "./scopes.js";
import type { ConsentRepository } from "./repository.js";
import { type ConsentRecord, type ConsentSource } from "./types.js";

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
  /** Did we recognise the file format? Used to skip writing the empty default. */
  recognised: boolean;
};

function loadFromDisk(filePath: string): LoadedFile {
  if (!existsSync(filePath)) {
    return { records: [], recognised: false };
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    // Unreadable file is treated as empty so a corrupted/missing file never
    // crashes the service. Operators can investigate via filesystem logs.
    return { records: [], recognised: false };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Corrupt JSON → empty store. Same fail-open-for-read principle as
    // `features/ical-calendar/cache.ts`.
    return { records: [], recognised: false };
  }

  const parsed = storeSchema.safeParse(payload);
  if (!parsed.success) {
    return { records: [], recognised: false };
  }

  return { records: parsed.data.records, recognised: true };
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

  async function load(): Promise<ConsentRecord[]> {
    const result = loadFromDisk(filePath);
    records = [...result.records];
    return [...records];
  }

  async function persist(next: ConsentRecord[]): Promise<void> {
    ensureDir(filePath);
    atomicWriteJson(filePath, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      records: next,
    });
    records = [...next];
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

  async function remove(subjectId: string, scope: ConsentScope): Promise<void> {
    const index = findIndex(subjectId, scope);
    if (index < 0) {
      return;
    }
    const next = [...records];
    next.splice(index, 1);
    await persist(next);
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
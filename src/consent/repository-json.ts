import { basename, dirname } from "node:path";

import { z } from "zod";
import { getStorageDriver } from "../lib/storage/index.js";
import { STORAGE_KEYS } from "../lib/storage/keys.js";
import { createLocalFileStorage } from "../lib/storage/local.js";
import type { StorageDriver } from "../lib/storage/types.js";
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
   * Storage driver to use. Defaults to the process-wide driver, which is
   * the local `data/` directory on a single host and object storage (U3)
   * on Altare.
   */
  driver?: StorageDriver;
  /**
   * Storage key of the registry. Defaults to `consent.json`.
   */
  key?: string;
  /**
   * Override the JSON file path. Tests inject a temp file here; the path
   * is served by a local filesystem driver rooted at its directory.
   */
  filePath?: string;
};

type LoadedFile = {
  records: ConsentRecord[];
  /**
   * `true` only when the stored object existed and we successfully parsed
   * it. `false` covers both "fresh start — no object" (writes are fine) and
   * "object exists but failed validation" (writes must refuse to clobber
   * the backup). The two cases are distinguished by `existed`.
   */
  recognised: boolean;
  /** Did an object exist in storage before this load attempt? */
  existed: boolean;
};

async function loadFromStorage(driver: StorageDriver, key: string): Promise<LoadedFile> {
  const raw = await driver.readText(key);
  if (raw === null) {
    return { existed: false, recognised: false, records: [] };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Corrupt JSON → empty store, but the object still exists, so a later
    // write must not silently overwrite it.
    return { existed: true, recognised: false, records: [] };
  }

  const parsed = storeSchema.safeParse(payload);
  if (!parsed.success) {
    // The stored object failed schema validation (future `schemaVersion`
    // bump, partial write, unexpected shape). Preserve the bytes so an
    // operator can recover, and flag the cache so subsequent persists
    // refuse to clobber them — silent data loss is unacceptable for a
    // privacy SoT.
    await driver.write(`${key}.unrecognised-${Date.now()}.bak`, raw).catch(() => {
      // best-effort backup; fall through with the empty cache + recognised=false
    });
    return { existed: true, recognised: false, records: [] };
  }

  return { existed: true, recognised: true, records: parsed.data.records };
}

export type JsonConsentRepository = ConsentRepository & {
  /** Resolved storage key. Useful for diagnostics + tests. */
  readonly key: string;
  /** Resolved storage driver. */
  readonly driver: StorageDriver;
};

export function createJsonConsentRepository(
  options: JsonConsentRepositoryOptions = {},
): JsonConsentRepository {
  // A `filePath` keeps the repository pinned to one file on the local
  // filesystem (tests, operators who want the registry next to the
  // process). Otherwise the registry lives in the shared storage backend.
  const driver = options.filePath
    ? createLocalFileStorage({ root: dirname(options.filePath) })
    : (options.driver ?? getStorageDriver());
  const key = options.filePath ? basename(options.filePath) : (options.key ?? STORAGE_KEYS.consent);

  // Cache records in memory; persist on every mutation. `load()` re-reads
  // from storage so a fresh process picks up the latest persisted state.
  let records: ConsentRecord[] = [];
  // `true` means writes are allowed. Defaults to `true` so a brand-new
  // repository (or a repository the caller never called `load()` on)
  // can persist immediately. `load()` flips it to `false` only when an
  // existing object failed schema validation — in that case mutations
  // refuse to clobber the backup that `loadFromStorage` left next to the
  // original. A fresh "object does not exist" load does NOT flip the flag
  // (there is nothing to be clobbered).
  let lastLoadRecognised = true;
  // Tracks whether the most recent `load()` actually read an object from
  // storage. Used to disambiguate "fresh start" from "existing unreadable
  // object" in the silent-data-loss unit test.
  let lastLoadExisted = false;

  async function load(): Promise<ConsentRecord[]> {
    const result = await loadFromStorage(driver, key);
    records = [...result.records];
    lastLoadExisted = result.existed;
    lastLoadRecognised = result.recognised;
    return [...records];
  }

  async function persist(next: ConsentRecord[]): Promise<void> {
    if (lastLoadExisted && !lastLoadRecognised) {
      // The most recent read failed schema validation; the original bytes
      // were preserved next to the original object. Refuse to write — an
      // operator must either inspect the backup or rotate to a known-good
      // object before persistence can resume.
      throw new Error(
        `consent repository: refusing to persist after unrecognised storage read at ${key} ` +
          `(a backup was preserved alongside the original object)`,
      );
    }
    await driver.write(
      key,
      `${JSON.stringify({ records: next, schemaVersion: CURRENT_SCHEMA_VERSION }, null, 2)}\n`,
    );
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
    driver,
    key,
    load,
    save,
    upsert,
    remove,
    clearSubject,
  };
}

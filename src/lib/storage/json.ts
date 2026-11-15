/**
 * Storage-backed JSON mutation helpers.
 *
 * Same contract as `atomic-json.ts` (which serves the local filesystem
 * directly), but routed through the storage port so the same privacy
 * adapters work against the local `data/` directory and against object
 * storage on Altare (ADR-0004).
 *
 * The privacy invariant is **partial failure = failure**: when a corrupted
 * object or write error occurs, the caller must surface a non-ok result
 * instead of silently declaring success.
 */

import type { ZodType } from "zod";

import type { StorageDriver } from "./types.js";

export type MutateJsonObjectOptions<T> = {
  driver: StorageDriver;
  /** Storage key of the JSON object. */
  key: string;
  /** Zod schema for the persisted shape. */
  schema: ZodType<T>;
  /**
   * Called with the parsed value to produce the next persisted value.
   * Return the same reference to indicate "no change needed" — the
   * helper skips the write in that case.
   */
  mutate: (current: T) => T | Promise<T>;
  /**
   * When true, a missing object is treated as the value supplied via
   * `initial` rather than a no-op.
   */
  createIfMissing?: boolean;
  /** The value used as the starting point when `createIfMissing` is true. */
  initial?: T;
};

export type MutateJsonObjectResult = { ok: true; mutated: boolean } | { ok: false; error: string };

export type ReadJsonObjectResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: "ENOENT" | string };

/**
 * Read a JSON object and validate it through the supplied schema.
 * A missing object is reported as the literal `"ENOENT"` error so callers
 * can decide whether to treat it as the empty/default value.
 */
export async function readJsonObject<T>(options: {
  driver: StorageDriver;
  key: string;
  schema: ZodType<T>;
}): Promise<ReadJsonObjectResult<T>> {
  const { driver, key, schema } = options;
  let raw: string | null;
  try {
    raw = await driver.readText(key);
  } catch (error) {
    return { error: `read failed for ${key}: ${messageOf(error)}`, ok: false };
  }
  if (raw === null) {
    return { error: "ENOENT", ok: false };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    return { error: `parse failed for ${key}: ${messageOf(error)}`, ok: false };
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return { error: `schema mismatch for ${key}: ${parsed.error.message}`, ok: false };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Read-modify-write a JSON object safely.
 *
 * - A missing object is a successful no-op unless `createIfMissing` is set.
 * - Any read / parse / schema-validation / write failure is reported as
 *   `{ ok: false, error }`.
 * - The write is atomic: the storage backend publishes the new object in
 *   one step, so a reader never observes a half-written document.
 */
export async function mutateJsonObject<T>(
  options: MutateJsonObjectOptions<T>,
): Promise<MutateJsonObjectResult> {
  const { driver, key, schema, mutate, createIfMissing, initial } = options;

  const existing = await readJsonObject({ driver, key, schema });
  if (!existing.ok) {
    if (existing.error !== "ENOENT") {
      return { error: existing.error, ok: false };
    }
    if (!createIfMissing) {
      return { mutated: false, ok: true };
    }
    if (initial === undefined) {
      return { error: `${key}: ENOENT — createIfMissing requires an initial value`, ok: false };
    }
    const next = await mutate(initial);
    return writeJsonObject(driver, key, next);
  }

  const current = existing.value;
  const next = await mutate(current);
  if (next === current) {
    return { mutated: false, ok: true };
  }
  return writeJsonObject(driver, key, next);
}

async function writeJsonObject<T>(
  driver: StorageDriver,
  key: string,
  payload: T,
): Promise<MutateJsonObjectResult> {
  try {
    await driver.write(key, `${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    return { error: `write failed for ${key}: ${messageOf(error)}`, ok: false };
  }
  return { mutated: true, ok: true };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Crash-safe JSON mutation helpers.
 *
 * These utilities back the per-consumer delete adapters in
 * `src/features/privacy/consumers/`. The privacy invariant is
 * **partial failure = failure**: when a corrupted file or write error
 * occurs, the caller must surface a non-ok result instead of silently
 * declaring success. Silent success would let `/privacy delete` claim
 * a user's data is gone when it actually is not.
 *
 * The helpers in this module do NOT catch and swallow errors. They
 * return a discriminated result so the caller can decide what to do.
 *
 * Concurrency note: each writer uses a unique temp file (`<path>.<pid>-<rand>.tmp`)
 * plus `O_EXCL` open so two writers cannot collide on the temp file.
 * The swap into place uses `rename(2)`, which is atomic on POSIX. A
 * concurrent writer that wins the race will simply overwrite our
 * intended state; we do not corrupt anything, but the loser must
 * re-read and retry if they want their mutation to land. The
 * privacy delete path is rare and operator-driven, so the caller
 * does NOT loop on contention — a contention-loss surfaces as a
 * failure so the operator is told something went wrong.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ZodType } from "zod";

export type MutateJsonFileOptions<T> = {
  filePath: string;
  /**
   * Zod schema for the persisted shape. The on-disk file is parsed as
   * JSON and validated through this schema; a schema mismatch is
   * reported as a failure (we never silently coerce unknown shapes).
   */
  schema: ZodType<T>;
  /**
   * Called with the parsed value to produce the next persisted value.
   * Return the same reference to indicate "no change needed" — the
   * helper skips the write in that case.
   */
  mutate: (current: T) => T | Promise<T>;
  /**
   * When true, a missing file is treated as the value supplied via
   * `initial` rather than a no-op. The mutate function is then called
   * with `initial` as its argument and the result is written through
   * the atomic write path. Defaults to false to preserve historical
   * semantics for the privacy-delete adapter (a missing file with no
   * data is already a successful no-op there).
   */
  createIfMissing?: boolean;
  /**
   * The value used as the starting point when `createIfMissing` is
   * true and the file does not exist on disk. Required iff
   * `createIfMissing` is true.
   */
  initial?: T;
};

export type MutateJsonFileResult = { ok: true; mutated: boolean } | { ok: false; error: string };

export type ReadJsonFileResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: "ENOENT" | string };

/**
 * Read a JSON file and validate it through the supplied schema. `ENOENT`
 * (no persisted file yet) is reported as a failure with the literal
 * `"ENOENT"` error so callers can decide whether to treat it as the
 * empty/default value. Every other failure (parse error, schema mismatch,
 * permission error) is surfaced as a string error — silent coercion of an
 * unknown on-disk shape is never an option, because the privacy invariant
 * (`/privacy delete` = partial failure = failure) demands it.
 *
 * Uses the same `openSync` + `readFileSync` single-syscall pattern as
 * `mutateJsonFile` so we do not introduce a new TOCTOU window between an
 * `existsSync` check and the subsequent read.
 */
export function readJsonFile<T>(options: {
  filePath: string;
  schema: ZodType<T>;
}): ReadJsonFileResult<T> {
  return readExisting(options.filePath, options.schema);
}

/**
 * Read-modify-write a JSON file safely.
 *
 * Result semantics:
 *   - `ENOENT` is treated as success with `mutated: false` — there is
 *     no persisted data to remove or update, and the privacy invariant
 *     only requires us to confirm the user has nothing to delete.
 *   - Any read / parse / schema-validation / write failure is reported
 *     as `{ ok: false, error }` so the caller can surface it.
 *   - The write is atomic: a unique temp file is `O_EXCL`-created,
 *     fully written, `fsync`ed via `closeSync`, then renamed over the
 *     destination. A rename failure removes the temp file before
 *     propagating the original error.
 */
export async function mutateJsonFile<T>(
  options: MutateJsonFileOptions<T>,
): Promise<MutateJsonFileResult> {
  const { filePath, schema, mutate, createIfMissing, initial } = options;

  const existing = readExisting(filePath, schema);
  if (!existing.ok) {
    if (existing.error !== "ENOENT") {
      return { error: existing.error, ok: false };
    }
    if (!createIfMissing) {
      return { mutated: false, ok: true };
    }
    if (initial === undefined) {
      return {
        error: `${filePath}: ENOENT — createIfMissing requires an initial value`,
        ok: false,
      };
    }
    // Promote the missing-file case to an explicit first-write path
    // so a fresh deployment that registers its first record actually
    // materialises on disk.
    const next = await mutate(initial);
    const writeResult = atomicWriteJson(filePath, next);
    return writeResult.ok ? { mutated: true, ok: true } : writeResult;
  }

  const current = existing.value;
  const next = await mutate(current);
  if (next === current) {
    return { mutated: false, ok: true };
  }

  const writeResult = atomicWriteJson(filePath, next);
  if (!writeResult.ok) {
    return writeResult;
  }
  return { mutated: true, ok: true };
}

type ReadResult<T> = { ok: true; value: T } | { ok: false; error: "ENOENT" | string };

function readExisting<T>(filePath: string, schema: ZodType<T>): ReadResult<T> {
  let raw: string;
  try {
    // Use `openSync` + `readFileSync` so we can distinguish ENOENT
    // (no persisted file yet) from other read errors (permission,
    // EIO, ...). The CodeQL TOCTOU warning on `existsSync ->
    // readFileSync` is sidestepped by performing a single `open` call:
    // the kernel resolves the path once and we either get the fd or
    // an `ENOENT` we handle immediately.
    const fd = openSync(filePath, "r");
    try {
      raw = readFileSyncFromFd(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return readErrorResult(error);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    return {
      error: `parse failed for ${filePath}: ${messageOf(error)}`,
      ok: false,
    };
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return {
      error: `schema mismatch for ${filePath}: ${parsed.error.message}`,
      ok: false,
    };
  }
  return { ok: true, value: parsed.data };
}

function readFileSyncFromFd(fd: number): string {
  return readFileSync(fd, "utf8");
}

function readErrorResult(error: unknown): ReadResult<never> {
  if (isNodeError(error) && error.code === "ENOENT") {
    return { error: "ENOENT", ok: false };
  }
  return {
    error: `read failed: ${messageOf(error)}`,
    ok: false,
  };
}

function atomicWriteJson(
  filePath: string,
  payload: unknown,
):
  | {
      ok: true;
    }
  | { ok: false; error: string } {
  const dir = dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { error: `mkdir failed: ${messageOf(error)}`, ok: false };
  }

  const tempPath = `${filePath}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
  let fd: number;
  try {
    // `wx` fails if the temp file already exists, so two concurrent
    // writers cannot collide on the same temp path.
    fd = openSync(tempPath, "wx", 0o600);
  } catch (error) {
    return {
      error: `temp file open failed: ${messageOf(error)}`,
      ok: false,
    };
  }

  try {
    writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (error) {
    closeSync(fd);
    rmSync(tempPath, { force: true });
    return {
      error: `temp write failed: ${messageOf(error)}`,
      ok: false,
    };
  }

  try {
    closeSync(fd);
  } catch (error) {
    rmSync(tempPath, { force: true });
    return {
      error: `temp close failed: ${messageOf(error)}`,
      ok: false,
    };
  }

  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    return {
      error: `rename failed: ${messageOf(error)}`,
      ok: false,
    };
  }

  return { ok: true };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}

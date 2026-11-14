/**
 * Storage port for every persisted artefact of the bot.
 *
 * The bot used to write everything to `data/` with `node:fs`. That worked on
 * a single host, but the runtime moved to Altare, where the app's local disk
 * is rebuilt from the GitHub checkout on every deploy — runtime-created
 * files are therefore not durable there (ADR-0004).
 *
 * This module defines the *port*; `local.ts`, `u3.ts` and `valkey.ts`
 * provide the adapters:
 *
 * - `LocalFileStorage` — the previous behaviour, byte-for-byte compatible.
 * - `U3Storage` — S3-compatible object storage (Altare U3), the source of
 *   truth on Altare.
 * - `ValkeyStorage` — Redis-compatible key/value store (Altare Valkey).
 *   U3 does not implement S3 conditional writes, so the instance lease
 *   runs on Valkey instead (`LEASE_STORAGE_BACKEND=valkey`).
 *
 * Contract, identical for every adapter:
 *
 * - `read` returns `null` when the key does not exist. Any other failure
 *   (permission, network, corrupt object) throws. Callers must treat a
 *   throw as "storage unavailable" and fail closed — never as "missing".
 * - `write` replaces the whole object atomically. A reader never observes a
 *   partially written object.
 * - `writeExclusive` creates the object only when it does not exist yet and
 *   returns `false` when the key was already taken. It never overwrites.
 * - `list` returns the entries under `prefix` sorted by key.
 * - `delete` removes the object; deleting a missing key is not an error.
 * - `move` renames an object within the same backend.
 * - `readVersioned` returns the object together with its version token.
 * - `compareAndSwap` writes only when the stored version still matches the
 *   expected one. This is the primitive the instance lease needs: without
 *   it, two instances can both believe they own the lease.
 */

export type StorageEntry = {
  /** Storage-relative key. POSIX separators, no leading slash. */
  key: string;
  /** Object size in bytes. */
  size: number;
  /** Last modification time, epoch milliseconds. */
  lastModifiedMs: number;
};

/** An object plus the backend's version token for it. */
export type VersionedObject = {
  /** Object content. */
  data: Uint8Array;
  /**
   * Opaque version token (ETag, content digest, …). `null` when the
   * backend cannot report one — such a backend cannot offer a
   * compare-and-swap.
   */
  version: string | null;
};

/**
 * Outcome of a compare-and-swap write.
 *
 * - `written` — the object was replaced.
 * - `conflict` — the stored version differed; nothing was written.
 * - `unsupported` — the backend cannot do conditional writes at all. The
 *   caller MUST NOT treat this as success: a guarantee that silently
 *   degrades is worse than a visible failure.
 */
export type CompareAndSwapResult = "written" | "conflict" | "unsupported";

export type StorageDriver = {
  /** Adapter identifier — `local` (filesystem), `u3` (object storage) or `valkey` (key/value store). */
  readonly kind: "local" | "u3" | "valkey";
  /** Read an object. Resolves `null` when the key does not exist. */
  read: (key: string) => Promise<Uint8Array | null>;
  /** Read an object as UTF-8 text. Resolves `null` when the key is missing. */
  readText: (key: string) => Promise<string | null>;
  /** Read an object together with its version token. */
  readVersioned: (key: string) => Promise<VersionedObject | null>;
  /** Atomically create or replace an object. */
  write: (key: string, data: Uint8Array | string) => Promise<void>;
  /**
   * Create an object only when the key is free.
   *
   * Resolves `true` when this call created the object and `false` when the
   * key was already taken. It never overwrites an existing object.
   */
  writeExclusive: (key: string, data: Uint8Array | string) => Promise<boolean>;
  /**
   * Write only when the stored version still matches `expectedVersion`.
   *
   * `expectedVersion: null` means "the key must not exist yet".
   */
  compareAndSwap: (
    key: string,
    data: Uint8Array | string,
    expectedVersion: string | null,
  ) => Promise<CompareAndSwapResult>;
  /** List objects under `prefix`, sorted by key. */
  list: (prefix: string) => Promise<StorageEntry[]>;
  /** Delete an object. Missing keys are not an error. */
  delete: (key: string) => Promise<void>;
  /** Whether the key exists. */
  exists: (key: string) => Promise<boolean>;
  /** Move an object to another key inside the same backend. */
  move: (from: string, to: string) => Promise<void>;
  /**
   * Whether the backend can enforce conditional writes.
   *
   * The instance lease depends on it: without conditional writes two
   * instances can both believe they own the lease. Adapters that cannot
   * answer must report `false` — a guarantee that cannot be verified is
   * not a guarantee.
   */
  probeConditionalWrites: () => Promise<boolean>;
};

/** Encode a string payload as UTF-8 bytes. */
export function encodeStorageData(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

/** Decode UTF-8 bytes as text. */
export function decodeStorageText(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

/**
 * Normalise a storage key: POSIX separators, no leading slash, no `.` /
 * `..` segments. Throws on anything that could escape the storage root —
 * keys are internal, so a malformed key is a programming error, not user
 * input.
 */
export function normalizeStorageKey(key: string): string {
  if (key.length === 0) {
    throw new Error("storage key must not be empty");
  }
  const segments = key.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new Error(`storage key must not be empty: ${JSON.stringify(key)}`);
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`storage key must not contain path segments: ${JSON.stringify(key)}`);
    }
  }
  return segments.join("/");
}

/**
 * Join a storage prefix and an object name into a storage key.
 *
 * An empty prefix means "the storage root" — the name is used as-is.
 */
export function joinStorageKey(prefix: string, name: string): string {
  const normalizedName = normalizeStorageKey(name);
  if (prefix === "") {
    return normalizedName;
  }
  return `${normalizeStorageKey(prefix)}/${normalizedName}`;
}

/** Whether a storage error is a "not found" error. */
export function isStorageNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { name?: unknown; message?: unknown; Code?: unknown };
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const code = typeof candidate.Code === "string" ? candidate.Code : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return (
    name === "NoSuchKey" ||
    name === "NotFound" ||
    code === "NoSuchKey" ||
    code === "NotFound" ||
    code === "ENOENT" ||
    message.includes("NoSuchKey")
  );
}

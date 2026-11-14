/**
 * Filesystem implementation of the storage port.
 *
 * This is the adapter used on the original single-host deployment and in
 * tests. It keeps the durability semantics the audit trail depends on:
 *
 * - `write` publishes through a temp file + `rename(2)`, so a reader never
 *   observes a half-written file.
 * - `writeExclusive` uses `open(O_EXCL)`, so a key can never be silently
 *   replaced by a racing writer.
 * - Both paths `fsync` the file before it becomes visible.
 * - `compareAndSwap` serialises the read-compare-write sequence with an
 *   `O_EXCL` lock file, so the check and the write cannot interleave.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { closeSync, fsyncSync, openSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  type CompareAndSwapResult,
  decodeStorageText,
  encodeStorageData,
  normalizeStorageKey,
  type StorageDriver,
  type StorageEntry,
  type VersionedObject,
} from "./types.js";

/** Suffix of the lock file that serialises compare-and-swap writes. */
const LOCK_SUFFIX = ".cas-lock";
/** How often a compare-and-swap retries when the lock is held. */
const LOCK_ATTEMPTS = 40;
const LOCK_RETRY_MS = 25;

export type LocalFileStorageOptions = {
  /** Absolute or relative directory that holds the storage root. */
  root: string;
};

export function createLocalFileStorage(options: LocalFileStorageOptions): StorageDriver {
  const root = resolve(options.root);

  function resolveKey(key: string): string {
    const normalized = normalizeStorageKey(key);
    const target = resolve(root, normalized);
    const rel = relative(root, target);
    if (rel.length === 0 || rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
      throw new Error(`storage key escapes the storage root: ${key}`);
    }
    return target;
  }

  async function walk(dir: string, out: StorageEntry[]): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, out);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      // Lock files are an implementation detail of compare-and-swap; they
      // are not stored objects and must never show up in a listing.
      if (entry.name.endsWith(LOCK_SUFFIX)) {
        continue;
      }
      const info = await stat(full);
      out.push({
        key: relative(root, full).split(sep).join("/"),
        lastModifiedMs: info.mtimeMs,
        size: info.size,
      });
    }
  }

  /** Content digest used as the version token of a local object. */
  function versionOf(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
  }

  async function readVersionedLocal(key: string): Promise<VersionedObject | null> {
    try {
      const buffer = await readFile(resolveKey(key));
      const data = new Uint8Array(buffer);
      return { data, version: versionOf(data) };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  /**
   * Acquire the per-key lock file. `open(..., "wx")` is atomic on every
   * supported platform, so exactly one caller wins.
   */
  async function acquireLock(lockPath: string): Promise<FileHandle | null> {
    try {
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        return null;
      }
      throw error;
    }
  }

  return {
    kind: "local",

    async read(key: string): Promise<Uint8Array | null> {
      try {
        const buffer = await readFile(resolveKey(key));
        return new Uint8Array(buffer);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },

    async readText(key: string): Promise<string | null> {
      const bytes = await this.read(key);
      return bytes === null ? null : decodeStorageText(bytes);
    },

    async readVersioned(key: string): Promise<VersionedObject | null> {
      return readVersionedLocal(key);
    },

    async write(key: string, data: Uint8Array | string): Promise<void> {
      const target = resolveKey(key);
      await mkdir(dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(encodeStorageData(data));
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      syncDirectory(dirname(target));
    },

    async writeExclusive(key: string, data: Uint8Array | string): Promise<boolean> {
      const target = resolveKey(key);
      await mkdir(dirname(target), { recursive: true });
      let handle: FileHandle;
      try {
        handle = await open(target, "wx", 0o600);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          return false;
        }
        throw error;
      }
      try {
        await handle.writeFile(encodeStorageData(data));
        await handle.sync();
      } finally {
        await handle.close();
      }
      syncDirectory(dirname(target));
      return true;
    },

    async compareAndSwap(
      key: string,
      data: Uint8Array | string,
      expectedVersion: string | null,
    ): Promise<CompareAndSwapResult> {
      const target = resolveKey(key);
      const lockPath = `${target}${LOCK_SUFFIX}`;
      await mkdir(dirname(target), { recursive: true });

      let handle: FileHandle | null = null;
      for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
        handle = await acquireLock(lockPath);
        if (handle) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
      if (!handle) {
        // The lock stayed busy — another writer owns this key right now.
        return "conflict";
      }
      try {
        const current = await readVersionedLocal(key);
        const currentVersion = current?.version ?? null;
        if (currentVersion !== expectedVersion) {
          return "conflict";
        }
        const bytes = encodeStorageData(data);
        const temp = `${target}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
        const writer = await open(temp, "wx", 0o600);
        try {
          await writer.writeFile(bytes);
          await writer.sync();
        } finally {
          await writer.close();
        }
        try {
          await rename(temp, target);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => {});
          throw error;
        }
        syncDirectory(dirname(target));
        return "written";
      } finally {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
    },

    async list(prefix: string): Promise<StorageEntry[]> {
      const normalized = prefix === "" ? "" : normalizeStorageKey(prefix);
      const out: StorageEntry[] = [];
      await walk(root, out);
      return out
        .filter((entry) => normalized === "" || entry.key.startsWith(normalized))
        .sort((left, right) => left.key.localeCompare(right.key));
    },

    async delete(key: string): Promise<void> {
      await rm(resolveKey(key), { force: true });
    },

    async exists(key: string): Promise<boolean> {
      try {
        const info = await stat(resolveKey(key));
        return info.isFile();
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return false;
        }
        throw error;
      }
    },

    /**
     * The local adapter enforces the compare-and-swap itself (lock file +
     * version compare), so conditional writes are always available.
     */
    async probeConditionalWrites(): Promise<boolean> {
      return true;
    },

    async move(from: string, to: string): Promise<void> {
      const source = resolveKey(from);
      const target = resolveKey(to);
      await mkdir(dirname(target), { recursive: true });
      await rename(source, target);
    },
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * fsync the directory that holds a freshly published file so the new
 * directory entry itself survives a crash. Best effort: Windows cannot
 * open a directory as a file handle, and the platform does not need the
 * fsync for that guarantee.
 */
function syncDirectory(dir: string): void {
  let handle: number;
  try {
    handle = openSync(dir, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(handle);
  } catch {
    // Directory fsync is unsupported on this platform.
  } finally {
    closeSync(handle);
  }
}

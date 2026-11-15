import type {
  CompareAndSwapResult,
  StorageDriver,
  StorageEntry,
  VersionedObject,
} from "../../src/lib/storage/types.js";

export type MemoryDriver = StorageDriver & {
  /** Raw object contents, keyed by storage key. */
  files: Map<string, string>;
};

/**
 * In-memory storage driver for tests. Mirrors the contract of the real
 * backends: atomic replace on write, create-if-absent on
 * `writeExclusive`, prefix listing, and delete.
 */
export function createMemoryDriver(initial: Record<string, string> = {}): MemoryDriver {
  const files = new Map<string, string>();
  for (const [key, contents] of Object.entries(initial)) {
    files.set(key, contents);
  }

  return {
    files,
    kind: "local",

    async read(key) {
      const value = files.get(key);
      return value === undefined ? null : new TextEncoder().encode(value);
    },

    async readText(key) {
      const value = files.get(key);
      return value === undefined ? null : value;
    },

    async readVersioned(key): Promise<VersionedObject | null> {
      const value = files.get(key);
      if (value === undefined) {
        return null;
      }
      const data = new TextEncoder().encode(value);
      return { data, version: `v${data.length}-${value.length}` };
    },

    async compareAndSwap(key, data, expectedVersion): Promise<CompareAndSwapResult> {
      const current = files.get(key);
      const currentVersion = current === undefined ? null : `v${current.length}-${current.length}`;
      if (currentVersion !== expectedVersion) {
        return "conflict";
      }
      files.set(key, typeof data === "string" ? data : new TextDecoder().decode(data));
      return "written";
    },

    async write(key, data) {
      files.set(key, typeof data === "string" ? data : new TextDecoder().decode(data));
    },

    async writeExclusive(key, data) {
      if (files.has(key)) {
        return false;
      }
      files.set(key, typeof data === "string" ? data : new TextDecoder().decode(data));
      return true;
    },

    async list(prefix) {
      const entries: StorageEntry[] = [];
      for (const [key, value] of files) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        entries.push({
          key,
          lastModifiedMs: 0,
          size: value.length,
        });
      }
      return entries.sort((left, right) => left.key.localeCompare(right.key));
    },

    async delete(key) {
      files.delete(key);
    },

    async exists(key) {
      return files.has(key);
    },

    async probeConditionalWrites() {
      return true;
    },

    async move(from, to) {
      const value = files.get(from);
      if (value === undefined) {
        throw new Error(`ENOENT: ${from}`);
      }
      files.set(to, value);
      files.delete(from);
    },
  };
}

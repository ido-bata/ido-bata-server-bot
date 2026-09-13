import type { FileSystemLike } from "../../src/features/multi-guild/store.js";

export type MemoryFs = FileSystemLike & {
  files: Map<string, string>;
};

export function createMemoryFs(initial: Record<string, string> = {}): MemoryFs {
  const files = new Map<string, string>();
  for (const [path, contents] of Object.entries(initial)) {
    files.set(path, contents);
  }

  function parent(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx === -1 ? "" : path.slice(0, idx);
  }

  return {
    files,
    existsSync(path) {
      if (files.has(path)) {
        return true;
      }
      // Treat directories as existing if any file under them does.
      for (const key of files.keys()) {
        if (key.startsWith(`${path}/`)) {
          return true;
        }
      }
      return false;
    },
    async mkdir(path, options) {
      if (!options?.recursive && this.existsSync(path)) {
        return;
      }
      // No real directory entries needed; file writes implicitly create paths.
      void path;
    },
    async readFile(path, encoding) {
      const value = files.get(path);
      if (value === undefined) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      void encoding;
      return value;
    },
    async writeFile(path, data) {
      const dir = parent(path);
      if (dir.length > 0) {
        files.set(`${dir}/.keep`, "");
      }
      files.set(path, data);
    },
    async readdir(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const seen = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        const remainder = key.slice(prefix.length);
        const slash = remainder.indexOf("/");
        if (slash === -1) {
          // It's a file directly under `path` — skip if looking for directory listing
          // because we don't track directories explicitly.
          continue;
        }
        seen.add(remainder.slice(0, slash));
      }
      return [...seen];
    },
  };
}

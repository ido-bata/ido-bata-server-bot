import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  buildGuildConfigPath,
  createDefaultGuildConfig,
  type GuildConfig,
  parseGuildConfig,
  serializeGuildConfig,
} from "./config.js";

export type ConfigStore = {
  loadGuild(guildId: string): Promise<GuildConfig>;
  loadGuildIfExists(guildId: string): Promise<GuildConfig | null>;
  saveGuild(config: GuildConfig): Promise<void>;
  removeGuild(guildId: string): Promise<void>;
  listGuildIds(): Promise<string[]>;
  exists(guildId: string): Promise<boolean>;
  ensureGuild(guildId: string): Promise<GuildConfig>;
};

export type FileSystemLike = {
  existsSync(path: string): boolean;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
};

const defaultFs: FileSystemLike = {
  existsSync,
  async mkdir(path, options) {
    await mkdir(path, options);
  },
  readFile,
  writeFile,
  async rename(from, to) {
    await rename(from, to);
  },
  async readdir(path) {
    const fs = await import("node:fs/promises");
    return fs.readdir(path);
  },
};

export function createFileConfigStore(
  options: { dataRoot?: string; fs?: FileSystemLike } = {},
): ConfigStore {
  const dataRoot = options.dataRoot ?? "data";
  const fs = options.fs ?? defaultFs;

  async function readGuildFile(guildId: string): Promise<string> {
    const path = buildGuildConfigPath(dataRoot, guildId);
    return fs.readFile(path, "utf8");
  }

  async function writeGuildFile(guildId: string, contents: string): Promise<void> {
    const path = buildGuildConfigPath(dataRoot, guildId);
    // Write to a sibling temp file, then `rename(2)` over the destination.
    // rename is atomic on POSIX, so concurrent readers always see either
    // the previous full file or the new full file — never a half-written
    // one. Temp lives next to the target so the rename stays within the
    // same filesystem.
    await fs.mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp-${randomSuffix()}`;
    try {
      await fs.writeFile(tempPath, contents);
      await fs.rename(tempPath, path);
    } catch (error) {
      // Best-effort cleanup so a failed write does not leave orphan .tmp
      // files lying around. Errors here are swallowed — the original
      // failure is what callers need to see.
      try {
        const fsPromises = await import("node:fs/promises");
        await fsPromises.unlink(tempPath);
      } catch {
        // ignore — temp file may not exist
      }
      throw error;
    }
  }

  function guildConfigDir(): string {
    return `${dataRoot}/guilds`;
  }

  function randomSuffix(): string {
    // 8 random bytes hex-encoded = 16 chars. Two concurrent writers are
    // overwhelmingly unlikely to collide; collisions just cause one of
    // them to fail the rename and surface the error to the caller.
    return randomBytes(8).toString("hex");
  }

  return {
    async loadGuild(guildId) {
      const raw = await readGuildFile(guildId);
      return parseGuildConfig(JSON.parse(raw), guildId);
    },

    async loadGuildIfExists(guildId) {
      const path = buildGuildConfigPath(dataRoot, guildId);
      if (!fs.existsSync(path)) {
        return null;
      }
      const raw = await readGuildFile(guildId);
      return parseGuildConfig(JSON.parse(raw), guildId);
    },

    async saveGuild(config) {
      if (!config.guildId) {
        throw new Error("Cannot save a guild config without a guildId");
      }
      await writeGuildFile(config.guildId, serializeGuildConfig(config));
    },

    async removeGuild(guildId) {
      const path = buildGuildConfigPath(dataRoot, guildId);
      if (!fs.existsSync(path)) {
        return;
      }
      const fsPromises = await import("node:fs/promises");
      await fsPromises.unlink(path);
    },

    async listGuildIds() {
      const dir = guildConfigDir();
      if (!fs.existsSync(dir)) {
        return [];
      }
      const entries = await fs.readdir(dir);
      const guildIds: string[] = [];
      for (const entry of entries) {
        if (!fs.existsSync(`${dir}/${entry}/config.json`)) {
          continue;
        }
        try {
          const raw = await fs.readFile(`${dir}/${entry}/config.json`, "utf8");
          const parsed = JSON.parse(raw) as { guildId?: unknown };
          if (typeof parsed.guildId === "string") {
            guildIds.push(parsed.guildId);
          } else {
            guildIds.push(entry);
          }
        } catch {
          guildIds.push(entry);
        }
      }
      return guildIds;
    },

    async exists(guildId) {
      const path = buildGuildConfigPath(dataRoot, guildId);
      return fs.existsSync(path);
    },

    async ensureGuild(guildId) {
      const existing = await this.loadGuildIfExists(guildId);
      if (existing) {
        return existing;
      }
      const fresh = createDefaultGuildConfig(guildId);
      await this.saveGuild(fresh);
      return fresh;
    },
  };
}

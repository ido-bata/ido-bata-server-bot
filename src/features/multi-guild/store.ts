import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
};

const defaultFs: FileSystemLike = {
  existsSync,
  async mkdir(path, options) {
    await mkdir(path, options);
  },
  readFile,
  writeFile,
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
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, contents);
  }

  function guildConfigDir(): string {
    return `${dataRoot}/guilds`;
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

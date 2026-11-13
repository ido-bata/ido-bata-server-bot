import { getStorageDriver } from "../../lib/storage/index.js";
import type { StorageDriver } from "../../lib/storage/types.js";
import {
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

export type ConfigStoreOptions = {
  /** Storage backend holding the per-guild configuration. */
  driver?: StorageDriver;
  /** Storage key prefix that holds the per-guild configuration. */
  prefix?: string;
};

function safeGuildSegment(guildId: string): string {
  return guildId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Per-guild configuration store.
 *
 * The configuration lives in the storage backend (ADR-0004): the local
 * `data/guilds/<guildId>/config.json` directory on a single host, the
 * `guilds/<guildId>/config.json` prefix inside the U3 bucket on Altare.
 */
export function createConfigStore(options: ConfigStoreOptions = {}): ConfigStore {
  const driver = options.driver ?? getStorageDriver();
  const prefix = options.prefix ?? "guilds";

  function guildKey(guildId: string): string {
    return `${prefix}/${safeGuildSegment(guildId)}/config.json`;
  }

  async function readGuildFile(guildId: string): Promise<string> {
    const raw = await driver.readText(guildKey(guildId));
    if (raw === null) {
      throw new Error(`guild config not found: ${guildId}`);
    }
    return raw;
  }

  async function writeGuildFile(guildId: string, contents: string): Promise<void> {
    // The storage backend publishes the new object atomically, so a
    // concurrent reader always sees either the previous full document or
    // the new full document — never a half-written one.
    await driver.write(guildKey(guildId), contents);
  }

  return {
    async loadGuild(guildId) {
      const raw = await readGuildFile(guildId);
      return parseGuildConfig(JSON.parse(raw), guildId);
    },

    async loadGuildIfExists(guildId) {
      const raw = await driver.readText(guildKey(guildId));
      if (raw === null) {
        return null;
      }
      return parseGuildConfig(JSON.parse(raw), guildId);
    },

    async saveGuild(config) {
      if (!config.guildId) {
        throw new Error("Cannot save a guild config without a guildId");
      }
      await writeGuildFile(config.guildId, serializeGuildConfig(config));
    },

    async removeGuild(guildId) {
      await driver.delete(guildKey(guildId));
    },

    async listGuildIds() {
      const entries = await driver.list(`${prefix}/`);
      const guildIds: string[] = [];
      for (const entry of entries) {
        if (!entry.key.endsWith("/config.json")) {
          continue;
        }
        const segment = entry.key.slice(`${prefix}/`.length).split("/")[0] ?? "";
        if (!segment) {
          continue;
        }
        try {
          const raw = await driver.readText(entry.key);
          if (raw === null) {
            continue;
          }
          const parsed = JSON.parse(raw) as { guildId?: unknown };
          guildIds.push(typeof parsed.guildId === "string" ? parsed.guildId : segment);
        } catch {
          guildIds.push(segment);
        }
      }
      return guildIds;
    },

    async exists(guildId) {
      return driver.exists(guildKey(guildId));
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

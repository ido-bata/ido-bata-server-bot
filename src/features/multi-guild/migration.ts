import { createDefaultGuildConfig, type GuildConfig } from "./config.js";
import type { ConfigStore } from "./store.js";

/**
 * Legacy single-guild env shape. Captured here so the migration helper can be
 * type-checked against the old contract independently of the new `BotConfig`.
 */
export type LegacyGuildEnv = {
  /** Legacy single-guild id (deprecated; superseded by `DISCORD_GUILD_IDS`). */
  DISCORD_GUILD_ID?: string;
  /** New multi-guild env: comma-separated guild ids. */
  DISCORD_GUILD_IDS?: string;
  /** Legacy timekeeper channel ids; only used when migrating one guild. */
  TIMEKEEPER_TEXT_CHANNEL_ID?: string;
  TIMEKEEPER_VOICE_CHANNEL_ID?: string;
  TIMEKEEPER_START_HOUR_JST?: string;
  TIMEKEEPER_START_MINUTE_JST?: string;
};

export type MigrationResult = {
  added: string[];
  skipped: string[];
  warnings: string[];
};

function parseGuildList(env: LegacyGuildEnv): string[] {
  const fromIds = env.DISCORD_GUILD_IDS?.split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (fromIds && fromIds.length > 0) {
    return [...new Set(fromIds)];
  }
  if (env.DISCORD_GUILD_ID && env.DISCORD_GUILD_ID.length > 0) {
    return [env.DISCORD_GUILD_ID];
  }
  return [];
}

function buildLegacyGuildConfig(guildId: string, env: LegacyGuildEnv): GuildConfig {
  const base = createDefaultGuildConfig(guildId);
  const textChannelId = env.TIMEKEEPER_TEXT_CHANNEL_ID;
  const voiceChannelId = env.TIMEKEEPER_VOICE_CHANNEL_ID;

  if (textChannelId && voiceChannelId) {
    const startHour = Number.parseInt(env.TIMEKEEPER_START_HOUR_JST ?? "21", 10);
    const startMinute = Number.parseInt(env.TIMEKEEPER_START_MINUTE_JST ?? "0", 10);
    base.timekeeper = {
      enabled: true,
      startHourJst: Number.isFinite(startHour) ? startHour : 21,
      startMinuteJst: Number.isFinite(startMinute) ? startMinute : 0,
      textChannelId,
      voiceChannelId,
      phases: [
        { label: "作業フェーズ 1", durationMinutes: 15 },
        { label: "5分休憩", durationMinutes: 5 },
        { label: "作業フェーズ 2", durationMinutes: 30 },
        { label: "5分休憩", durationMinutes: 5 },
        { label: "作業フェーズ 3", durationMinutes: 45 },
      ],
    };
  }

  return base;
}

/**
 * Migrate legacy env-based single-guild config into per-guild JSON configs.
 *
 * - Reads `DISCORD_GUILD_IDS` (preferred) or `DISCORD_GUILD_ID` (deprecated).
 * - For each guild that does not yet have a config file, writes one derived
 *   from the legacy env (timekeeper channels etc.).
 * - Returns which guilds were newly added, which already had configs, and any
 *   non-fatal warnings about the env shape.
 */
export async function migrateLegacyEnvToGuildConfigs(
  env: LegacyGuildEnv,
  store: ConfigStore,
): Promise<MigrationResult> {
  const warnings: string[] = [];
  const added: string[] = [];
  const skipped: string[] = [];

  if (env.DISCORD_GUILD_ID && env.DISCORD_GUILD_IDS) {
    warnings.push(
      "Both DISCORD_GUILD_ID and DISCORD_GUILD_IDS are set; DISCORD_GUILD_IDS takes precedence (DISCORD_GUILD_ID is deprecated).",
    );
  } else if (env.DISCORD_GUILD_ID) {
    warnings.push(
      "DISCORD_GUILD_ID is deprecated; prefer the comma-separated DISCORD_GUILD_IDS env var for multi-guild deployments.",
    );
  }

  const guildIds = parseGuildList(env);
  if (guildIds.length === 0) {
    warnings.push("No guild ids provided via DISCORD_GUILD_IDS or DISCORD_GUILD_ID.");
  }

  for (const guildId of guildIds) {
    const existing = await store.loadGuildIfExists(guildId);
    if (existing) {
      skipped.push(guildId);
      continue;
    }
    const fresh = buildLegacyGuildConfig(guildId, env);
    await store.saveGuild(fresh);
    added.push(guildId);
  }

  return { added, skipped, warnings };
}

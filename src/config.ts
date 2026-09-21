import { z } from "zod";

import { type ConsentConfig, readConsentConfig } from "./consent/config.js";

const configSchema = z
  .object({
    DISCORD_TOKEN: z.string().min(1),
    DISCORD_CLIENT_ID: z.string().min(1),
    // Legacy single-guild env (deprecated). Either DISCORD_GUILD_ID or
    // DISCORD_GUILD_IDS must be supplied; both is fine — IDs are unioned.
    DISCORD_GUILD_ID: z.string().optional(),
    // Comma-separated list of guild ids this process should connect to.
    DISCORD_GUILD_IDS: z.string().optional(),
    // Optional: audit log channel for `/role` slash command usage. When set,
    // the bot forwards a structured entry to the channel after each command.
    ROLE_AUDIT_CHANNEL_ID: z.string().optional(),
  })
  .refine((env) => parseGuildList(env.DISCORD_GUILD_ID, env.DISCORD_GUILD_IDS).length > 0, {
    message:
      "At least one guild id is required: set DISCORD_GUILD_ID (legacy) or DISCORD_GUILD_IDS (comma-separated).",
  });

export type BotConfig = {
  discordToken: string;
  discordClientId: string;
  /** Legacy single-guild id (deprecated). May be empty when using DISCORD_GUILD_IDS. */
  discordGuildId: string;
  /** Resolved multi-guild ids (deduplicated). Always includes the legacy id when set. */
  discordGuildIds: string[];
  enableMessageContentIntent: boolean;
  enableGuildMembersIntent: boolean;
  enablePresenceIntent: boolean;
  roleAuditChannelId: string | null;
  /** Consent registry config. `enabled` is false when `CONSENT_MESSAGE_ID` is empty. */
  consent: ConsentConfig;
};

function parseGuildList(guildId?: string, guildIds?: string): string[] {
  const set = new Set<string>();
  if (guildIds && guildIds.length > 0) {
    for (const id of guildIds.split(",")) {
      const trimmed = id.trim();
      if (trimmed.length > 0) {
        set.add(trimmed);
      }
    }
  }
  if (guildId) {
    const trimmed = guildId.trim();
    if (trimmed.length > 0) {
      set.add(trimmed);
    }
  }
  return [...set];
}

export function readConfig(env: NodeJS.ProcessEnv): BotConfig {
  const parsed = configSchema.parse(env);
  const enableMessageContentIntent = env.DISCORD_ENABLE_MESSAGE_CONTENT === "true";
  const enableGuildMembersIntent = env.DISCORD_ENABLE_GUILD_MEMBERS === "true";
  const enablePresenceIntent = env.DISCORD_ENABLE_PRESENCE === "true";
  const roleAuditChannelId = parsed.ROLE_AUDIT_CHANNEL_ID?.trim() || null;
  const discordGuildIds = parseGuildList(parsed.DISCORD_GUILD_ID, parsed.DISCORD_GUILD_IDS);
  const consent = readConsentConfig({
    CONSENT_MESSAGE_ID: env.CONSENT_MESSAGE_ID,
    CONSENT_CHANNEL_ID: env.CONSENT_CHANNEL_ID,
    CONSENT_GUILD_ID: env.CONSENT_GUILD_ID,
    CONSENT_EMOJI: env.CONSENT_EMOJI,
    CONSENT_POLICY_VERSION: env.CONSENT_POLICY_VERSION,
    DISCORD_GUILD_ID: env.DISCORD_GUILD_ID,
  });

  return {
    discordToken: parsed.DISCORD_TOKEN,
    discordClientId: parsed.DISCORD_CLIENT_ID,
    discordGuildId: parsed.DISCORD_GUILD_ID ?? "",
    discordGuildIds,
    enableMessageContentIntent,
    enableGuildMembersIntent,
    enablePresenceIntent,
    roleAuditChannelId,
    consent,
  };
}

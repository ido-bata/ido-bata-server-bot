import { z } from "zod";

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
    // Structured logger configuration. `LOG_LEVEL` is forwarded to pino;
    // `LOG_RING_SIZE` bounds the in-memory ring buffer that powers the
    // recent-events stream (TUI log panel, etc.).
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    LOG_RING_SIZE: z.coerce.number().int().min(10).max(10_000).default(200),
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
  /** Pino level forwarded to the structured logger. */
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  /** Capacity of the in-memory ring buffer backing the recent-events stream. */
  logRingSize: number;
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

  return {
    discordToken: parsed.DISCORD_TOKEN,
    discordClientId: parsed.DISCORD_CLIENT_ID,
    discordGuildId: parsed.DISCORD_GUILD_ID ?? "",
    discordGuildIds,
    enableMessageContentIntent,
    enableGuildMembersIntent,
    enablePresenceIntent,
    roleAuditChannelId,
    logLevel: parsed.LOG_LEVEL,
    logRingSize: parsed.LOG_RING_SIZE,
  };
}

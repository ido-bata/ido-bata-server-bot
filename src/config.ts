import { z } from "zod";

const configSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  // Legacy single-guild env (deprecated). Either DISCORD_GUILD_ID or
  // DISCORD_GUILD_IDS must be supplied; both is fine — IDs are unioned.
  DISCORD_GUILD_ID: z.string().optional(),
  // Comma-separated list of guild ids this process should connect to.
  DISCORD_GUILD_IDS: z.string().optional(),
});

export type BotConfig = {
  discordToken: string;
  discordClientId: string;
  /** Legacy single-guild id (deprecated). May be empty when using DISCORD_GUILD_IDS. */
  discordGuildId: string;
  /** Resolved multi-guild ids (deduplicated). Always includes the legacy id when set. */
  discordGuildIds: string[];
  enableMessageContentIntent: boolean;
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
  if (guildId && guildId.length > 0) {
    set.add(guildId);
  }
  return [...set];
}

export function readConfig(env: NodeJS.ProcessEnv): BotConfig {
  const parsed = configSchema.parse(env);
  const enableMessageContentIntent = env.DISCORD_ENABLE_MESSAGE_CONTENT === "true";
  const discordGuildIds = parseGuildList(parsed.DISCORD_GUILD_ID, parsed.DISCORD_GUILD_IDS);

  return {
    discordToken: parsed.DISCORD_TOKEN,
    discordClientId: parsed.DISCORD_CLIENT_ID,
    discordGuildId: parsed.DISCORD_GUILD_ID ?? "",
    discordGuildIds,
    enableMessageContentIntent,
  };
}

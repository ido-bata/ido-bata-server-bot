import { z } from "zod";

const configSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
});

export type BotConfig = {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
  enableMessageContentIntent: boolean;
  /**
   * Privileged Guild Presences intent. Off by default; turn it on in the
   * Discord Developer Portal AND via env so listeners (game activity,
   * Spotify) actually fire.
   */
  enablePresenceIntent: boolean;
};

export function readConfig(env: NodeJS.ProcessEnv): BotConfig {
  const parsed = configSchema.parse(env);
  const enableMessageContentIntent = env.DISCORD_ENABLE_MESSAGE_CONTENT === "true";
  const enablePresenceIntent = env.DISCORD_ENABLE_PRESENCE_INTENT === "true";

  return {
    discordToken: parsed.DISCORD_TOKEN,
    discordClientId: parsed.DISCORD_CLIENT_ID,
    discordGuildId: parsed.DISCORD_GUILD_ID,
    enableMessageContentIntent,
    enablePresenceIntent,
  };
}

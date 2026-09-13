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
  enablePresenceIntent: boolean;
};

export function readConfig(env: NodeJS.ProcessEnv): BotConfig {
  const parsed = configSchema.parse(env);
  const enableMessageContentIntent = env.DISCORD_ENABLE_MESSAGE_CONTENT === "true";
  const enablePresenceIntent = env.DISCORD_ENABLE_PRESENCE === "true";

  return {
    discordToken: parsed.DISCORD_TOKEN,
    discordClientId: parsed.DISCORD_CLIENT_ID,
    discordGuildId: parsed.DISCORD_GUILD_ID,
    enableMessageContentIntent,
    enablePresenceIntent,
  };
}

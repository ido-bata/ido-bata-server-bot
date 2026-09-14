import { z } from "zod";

const DEFAULT_VOICE_CONNECTION_TIMEOUT_MS = 30_000;

const configSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  VOICE_CONNECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_VOICE_CONNECTION_TIMEOUT_MS),
});

export type BotConfig = {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
  enableMessageContentIntent: boolean;
  voiceConnectionTimeoutMs: number;
};

export function readConfig(env: NodeJS.ProcessEnv): BotConfig {
  const parsed = configSchema.parse(env);
  const enableMessageContentIntent = env.DISCORD_ENABLE_MESSAGE_CONTENT === "true";

  return {
    discordToken: parsed.DISCORD_TOKEN,
    discordClientId: parsed.DISCORD_CLIENT_ID,
    discordGuildId: parsed.DISCORD_GUILD_ID,
    enableMessageContentIntent,
    voiceConnectionTimeoutMs: parsed.VOICE_CONNECTION_TIMEOUT_MS,
  };
}

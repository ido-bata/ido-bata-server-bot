import { z } from "zod";

const configSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  // Optional: audit log channel for `/role` slash command usage. When set,
  // the bot forwards a structured entry to the channel after each command.
  ROLE_AUDIT_CHANNEL_ID: z.string().optional(),
});

export type BotConfig = {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
  enableMessageContentIntent: boolean;
  roleAuditChannelId: string | null;
};

export function readConfig(env: NodeJS.ProcessEnv): BotConfig {
  const parsed = configSchema.parse(env);
  const enableMessageContentIntent = env.DISCORD_ENABLE_MESSAGE_CONTENT === "true";
  const roleAuditChannelId = parsed.ROLE_AUDIT_CHANNEL_ID?.trim() || null;

  return {
    discordToken: parsed.DISCORD_TOKEN,
    discordClientId: parsed.DISCORD_CLIENT_ID,
    discordGuildId: parsed.DISCORD_GUILD_ID,
    enableMessageContentIntent,
    roleAuditChannelId,
  };
}
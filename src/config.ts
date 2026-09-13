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
<<<<<<< HEAD
  enableGuildMembersIntent: boolean;
=======
  roleAuditChannelId: string | null;
>>>>>>> 3d7341a (feat(bot): add /role assign and /role remove slash commands)
};

export function readConfig(env: NodeJS.ProcessEnv): BotConfig {
  const parsed = configSchema.parse(env);
  const enableMessageContentIntent = env.DISCORD_ENABLE_MESSAGE_CONTENT === "true";
<<<<<<< HEAD
  const enableGuildMembersIntent = env.DISCORD_ENABLE_GUILD_MEMBERS === "true";
=======
  const roleAuditChannelId = parsed.ROLE_AUDIT_CHANNEL_ID?.trim() || null;
>>>>>>> 3d7341a (feat(bot): add /role assign and /role remove slash commands)

  return {
    discordToken: parsed.DISCORD_TOKEN,
    discordClientId: parsed.DISCORD_CLIENT_ID,
    discordGuildId: parsed.DISCORD_GUILD_ID,
    enableMessageContentIntent,
<<<<<<< HEAD
    enableGuildMembersIntent,
=======
    roleAuditChannelId,
>>>>>>> 3d7341a (feat(bot): add /role assign and /role remove slash commands)
  };
}
import { z } from "zod";

const emojiSchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
});

const reactionRoleRuleSchema = z.object({
  messageId: z.string().min(1),
  emoji: z.string().min(1),
  roleId: z.string().min(1),
});

const timekeeperPhaseSchema = z.object({
  durationMinutes: z.number().int().positive(),
  label: z.string().min(1),
});

const timekeeperSchema = z.object({
  enabled: z.boolean().default(true),
  startHourJst: z.number().int().min(0).max(23),
  startMinuteJst: z.number().int().min(0).max(59),
  textChannelId: z.string().min(1),
  voiceChannelId: z.string().min(1),
  phases: z.array(timekeeperPhaseSchema).min(1),
});

export const guildConfigSchema = z.object({
  guildId: z.string().min(1),
  reactionRoles: z.array(reactionRoleRuleSchema).default([]),
  timekeeper: timekeeperSchema.optional(),
  customEmojis: z.array(emojiSchema).default([]),
});

export type ReactionRoleRule = z.infer<typeof reactionRoleRuleSchema>;
export type TimekeeperPhase = z.infer<typeof timekeeperPhaseSchema>;
export type TimekeeperSettings = z.infer<typeof timekeeperSchema>;
export type GuildEmoji = z.infer<typeof emojiSchema>;
export type GuildConfig = z.infer<typeof guildConfigSchema>;

export function createDefaultGuildConfig(guildId: string): GuildConfig {
  return {
    guildId,
    reactionRoles: [],
    customEmojis: [],
  };
}

export function parseGuildConfig(raw: unknown, guildIdHint?: string): GuildConfig {
  const parsed = guildConfigSchema.parse(raw);
  if (guildIdHint && parsed.guildId !== guildIdHint) {
    throw new Error(
      `Guild config guildId mismatch: file says ${parsed.guildId}, path says ${guildIdHint}`,
    );
  }
  return parsed;
}

export function serializeGuildConfig(config: GuildConfig): string {
  return JSON.stringify(config, null, 2);
}

export function buildGuildConfigPath(dataRoot: string, guildId: string): string {
  const safeGuildId = guildId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${dataRoot}/guilds/${safeGuildId}/config.json`;
}

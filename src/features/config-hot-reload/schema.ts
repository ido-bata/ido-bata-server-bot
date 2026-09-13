import { z } from "zod";

/**
 * Runtime-tunable configuration items that can be hot-reloaded without a
 * bot restart. Every field is optional so partial files merge over the
 * existing in-memory snapshot.
 *
 * Items that intentionally live here:
 * - announcement / audit-log channel IDs
 * - role IDs the bot grants or reacts to
 * - feature toggles that can be flipped while the bot is live
 *
 * Items that are NOT here (require a restart):
 * - Discord intents (must match the Client intents array)
 * - env-derived secrets (`DISCORD_TOKEN`, client/guild IDs)
 * - dependency versions
 */
const discordSnowflake = z
  .string()
  .regex(/^\d{17,20}$/, "must be a Discord snowflake (17-20 digits)");

export const hotReloadConfigSchema = z
  .object({
    announcementChannelId: discordSnowflake.optional(),
    auditLogChannelId: discordSnowflake.optional(),
    memberRoleId: discordSnowflake.optional(),
    guestRoleId: discordSnowflake.optional(),
    enableWelcomeMessage: z.boolean().optional(),
    enableAuditLogging: z.boolean().optional(),
  })
  .strict();

export type HotReloadConfig = z.infer<typeof hotReloadConfigSchema>;

export function parseHotReloadConfig(raw: unknown): HotReloadConfig {
  return hotReloadConfigSchema.parse(raw);
}

export function safeParseHotReloadConfig(raw: unknown): {
  ok: boolean;
  data?: HotReloadConfig;
  error?: z.ZodError;
} {
  const result = hotReloadConfigSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, error: result.error };
}

import { PermissionFlagsBits } from "discord.js";

/**
 * Permission tiers supported by `default_member_permissions` for the bot's
 * slash commands. The order is meaningful — `everyone` is the most permissive
 * (no requirement), `administrator` is the most restrictive.
 *
 * Each level maps to exactly one Discord permission bit so the deployment
 * payload can carry a single `default_member_permissions` integer. A DM
 * channel always bypasses `default_member_permissions`, which is documented
 * Discord behaviour and intentionally not handled here.
 */
export const SLASH_PERMISSION_LEVELS = [
  "everyone",
  "manage_messages",
  "manage_channels",
  "administrator",
] as const;

export type SlashPermissionLevel = (typeof SLASH_PERMISSION_LEVELS)[number];

export function isSlashPermissionLevel(value: unknown): value is SlashPermissionLevel {
  return (
    typeof value === "string" && (SLASH_PERMISSION_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Discord permission bit associated with each permission level.
 *
 * `everyone` has no requirement, so its bit is `0n` (which Discord interprets
 * as "no restriction beyond being able to run slash commands in the guild").
 *
 * Anything that does not appear in this map is rejected by
 * `permissionBitFor()` so we cannot accidentally register a command with an
 * unknown or empty permission requirement.
 */
const PERMISSION_BITS: Record<SlashPermissionLevel, bigint> = {
  everyone: 0n,
  manage_messages: PermissionFlagsBits.ManageMessages,
  manage_channels: PermissionFlagsBits.ManageChannels,
  administrator: PermissionFlagsBits.Administrator,
};

export function permissionBitFor(level: SlashPermissionLevel): bigint {
  const bit = PERMISSION_BITS[level];
  // The map is exhaustive over `SLASH_PERMISSION_LEVELS`, so this lookup is
  // infallible at the type level; the runtime guard makes it explicit.
  if (bit === undefined) {
    throw new Error(`permissionBitFor: unknown slash permission level: ${level}`);
  }
  return bit;
}

/**
 * Discord stores `default_member_permissions` as a stringified integer in the
 * REST payload. Returning a decimal string keeps the value unambiguous in
 * JSON, avoids JS number-precision pitfalls for `bigint`, and matches the
 * format Discord returns in its API responses.
 */
export function defaultMemberPermissionsFor(level: SlashPermissionLevel): string {
  return permissionBitFor(level).toString();
}

/**
 * Runtime permission check used by slash command dispatchers. A `null`
 * `memberPermissions` (typical of DM interactions) is treated as
 * "not in a guild" — `everyone` still passes, every other level denies.
 */
export function memberHasSlashPermission(
  memberPermissions: { has: (flag: bigint) => boolean } | null | undefined,
  level: SlashPermissionLevel,
): boolean {
  if (level === "everyone") {
    return true;
  }

  if (!memberPermissions) {
    return false;
  }

  return memberPermissions.has(permissionBitFor(level));
}

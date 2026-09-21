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
 * `everyone` has no requirement, so it maps to `null` rather than `0n`.
 * Discord treats `default_member_permissions: "0"` as **all denied** (only
 * administrators or explicit overwrites may use the command); omitting the
 * field entirely means "no restriction". Emitting `"0"` for an
 * `everyone`-level command is therefore a functional regression — see PR
 * review VK2V.
 *
 * Anything that does not appear in this map is rejected by
 * `permissionBitFor()` so we cannot accidentally register a command with an
 * unknown or empty permission requirement.
 */
const PERMISSION_BITS: Record<SlashPermissionLevel, bigint | null> = {
  everyone: null,
  manage_messages: PermissionFlagsBits.ManageMessages,
  manage_channels: PermissionFlagsBits.ManageChannels,
  administrator: PermissionFlagsBits.Administrator,
};

export function permissionBitFor(level: SlashPermissionLevel): bigint | null {
  const bit = PERMISSION_BITS[level];
  // The map is exhaustive over `SLASH_PERMISSION_LEVELS`, so this lookup is
  // infallible at the type level; the runtime guard makes it explicit.
  if (bit === undefined) {
    throw new Error(`permissionBitFor: unknown slash permission level: ${level}`);
  }
  return bit;
}

/**
 * Value to emit as `default_member_permissions` for the given level.
 *
 * - `null`  : omit the field entirely (Discord defaults to "everyone").
 *            Returned for the `everyone` level.
 * - `string`: the stringified bit value Discord stores on the command
 *            (decimal string for `bigint`).
 *
 * Returning the string format matches what Discord returns in its API
 * responses and sidesteps JS number-precision pitfalls for `bigint`.
 */
export function defaultMemberPermissionsFor(level: SlashPermissionLevel): string | null {
  const bit = permissionBitFor(level);
  return bit === null ? null : bit.toString();
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

  // `permissionBitFor` returns `bigint | null` (null only for `everyone`,
  // which we already short-circuited above), so the cast strips the union.
  const bit = permissionBitFor(level) as unknown as bigint;
  return memberPermissions.has(bit);
}

import { resolveSlashPermissionLevel } from "./config.js";
import {
  defaultMemberPermissionsFor,
  isSlashPermissionLevel,
  memberHasSlashPermission,
  type SlashPermissionLevel,
} from "./policy.js";

/**
 * Minimal structural type for the dispatcher to extract what it needs from a
 * `ChatInputCommandInteraction`. Keeping this narrow lets us construct fakes
 * in tests without spinning up a real Discord Client — the real interaction
 * from `discord.js` satisfies this shape verbatim.
 */
export type SlashCommandInteractionLike = {
  commandName: string;
  memberPermissions: { has: (flag: bigint) => boolean } | null;
  inGuild: () => boolean;
  channelId: string | null;
  user: { id: string };
  isRepliable: () => boolean;
  reply: (options: { content: string; ephemeral?: boolean }) => Promise<unknown>;
};

export type SlashPermissionDecision =
  | { allowed: true; level: SlashPermissionLevel }
  | { allowed: false; level: SlashPermissionLevel; reason: "missing_permission" | "dm_channel" };

/**
 * Pure decision function: returns whether the interaction should proceed and,
 * if not, the human-readable reason. No side effects, no Discord API calls —
 * the dispatcher wires the actual reply.
 */
export function evaluateSlashPermission(
  interaction: Pick<SlashCommandInteractionLike, "commandName" | "memberPermissions" | "inGuild">,
): SlashPermissionDecision {
  const level = resolveSlashPermissionLevel(interaction.commandName);

  // Discord bypasses `default_member_permissions` for DMs. Treat DM usage of
  // any moderator-only command as denied to keep the policy predictable
  // across channels; `everyone`-level commands still proceed (the existing
  // dispatcher can decide whether to reply in DMs at all).
  if (!interaction.inGuild() && level !== "everyone") {
    return { allowed: false, level, reason: "dm_channel" };
  }

  if (!memberHasSlashPermission(interaction.memberPermissions, level)) {
    return { allowed: false, level, reason: "missing_permission" };
  }

  return { allowed: true, level };
}

/**
 * Convenience wrapper that evaluates the decision and, when denied, posts the
 * ephemeral reply. Returns the decision so callers can branch on it (audit
 * logging, telemetry, etc.).
 */
export async function assertSlashPermission(
  interaction: SlashCommandInteractionLike,
): Promise<SlashPermissionDecision> {
  const decision = evaluateSlashPermission(interaction);

  if (decision.allowed) {
    return decision;
  }

  if (interaction.isRepliable()) {
    await interaction.reply({
      content: messageForDecision(decision),
      ephemeral: true,
    });
  }

  return decision;
}

export function messageForDecision(
  decision: Extract<SlashPermissionDecision, { allowed: false }>,
): string {
  if (decision.reason === "dm_channel") {
    return "このコマンドはサーバ内で実行してください。";
  }
  return "このコマンドを実行する権限がありません。";
}

/**
 * Decorator-friendly helper that mutates a REST payload (or a builder that
 * exposes `toJSON()`) so it carries the correct `default_member_permissions`.
 *
 * Discord ignores `default_member_permissions` for global registration and
 * always honours it for guild registration, so the deploy script should
 * always go through the guild route — see ADR-0002 / `deploySlashCommands`.
 */
export function applyDefaultMemberPermissions<
  T extends { toJSON?: () => Record<string, unknown> } | Record<string, unknown>,
>(payload: T, level: SlashPermissionLevel | string): T & { default_member_permissions: string } {
  if (!isSlashPermissionLevel(level)) {
    throw new Error(`applyDefaultMemberPermissions: unknown slash permission level: ${level}`);
  }

  const next = payload as T & { default_member_permissions?: string };
  next.default_member_permissions = defaultMemberPermissionsFor(level);
  return next as T & { default_member_permissions: string };
}

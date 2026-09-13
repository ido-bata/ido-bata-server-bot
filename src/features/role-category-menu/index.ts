/**
 * Category menu helpers for reaction-roles.
 *
 * A category groups multiple emoji → role mappings under a single message.
 * Discord limits each message to 20 reactions; this module enforces that bound
 * and formats the message body (description line + emoji legend).
 */

export const DISCORD_MAX_REACTIONS_PER_MESSAGE = 20;

export type CategoryEmojiEntry = {
  /** Emoji key in the same shape produced by `toEmojiKey` (unicode name or custom id). */
  emoji: string;
  /** Role granted when a member reacts with `emoji`. */
  roleId: string;
};

export type CategoryRule = {
  messageId: string;
  description: string;
  emojis: CategoryEmojiEntry[];
};

export type CategoryValidationError = {
  code:
    | "empty"
    | "too_many"
    | "duplicate_emoji"
    | "duplicate_role"
    | "missing_emoji"
    | "missing_role";
  message: string;
};

/**
 * Validate a single category rule. Returns the list of errors (empty = valid).
 * The check is non-throwing so a config file with multiple issues surfaces every
 * problem in one pass.
 */
export function validateCategoryRule(rule: CategoryRule): CategoryValidationError[] {
  const errors: CategoryValidationError[] = [];

  if (rule.emojis.length === 0) {
    errors.push({
      code: "empty",
      message: `category rule for message ${rule.messageId} has no emoji entries`,
    });
    return errors;
  }

  if (rule.emojis.length > DISCORD_MAX_REACTIONS_PER_MESSAGE) {
    errors.push({
      code: "too_many",
      message:
        `category rule for message ${rule.messageId} has ${rule.emojis.length} ` +
        `entries, exceeding the Discord limit of ${DISCORD_MAX_REACTIONS_PER_MESSAGE}`,
    });
  }

  const seenEmoji = new Set<string>();
  const seenRoles = new Set<string>();

  for (const entry of rule.emojis) {
    if (!entry.emoji) {
      errors.push({
        code: "missing_emoji",
        message: `category rule for message ${rule.messageId} has an entry without an emoji`,
      });
    } else if (seenEmoji.has(entry.emoji)) {
      errors.push({
        code: "duplicate_emoji",
        message: `category rule for message ${rule.messageId} repeats emoji ${entry.emoji}`,
      });
    } else {
      seenEmoji.add(entry.emoji);
    }

    if (!entry.roleId) {
      errors.push({
        code: "missing_role",
        message: `category rule for message ${rule.messageId} has an entry without a roleId`,
      });
    } else if (seenRoles.has(entry.roleId)) {
      errors.push({
        code: "duplicate_role",
        message: `category rule for message ${rule.messageId} repeats roleId ${entry.roleId}`,
      });
    } else {
      seenRoles.add(entry.roleId);
    }
  }

  return errors;
}

/**
 * Render the body of a category menu message.
 *
 * Format:
 *   <description>
 *
 *   <emoji> — <roleId>
 *   <emoji> — <roleId>
 *   ...
 *
 * The trailing dash separator is intentional: role IDs are Discord snowflakes
 * (numeric) so the line is unambiguous even for non-technical readers.
 */
export function formatCategoryMessage(rule: CategoryRule): string {
  const legend = rule.emojis.map((entry) => `${entry.emoji} — <@&${entry.roleId}>`).join("\n");
  return `${rule.description}\n\n${legend}`;
}

/**
 * Look up the role mapped to a given emoji within a category rule.
 * Returns null when the emoji is not registered for the message.
 */
export function findCategoryRoleId(rule: CategoryRule, emojiKey: string | null): string | null {
  if (!emojiKey) {
    return null;
  }

  return rule.emojis.find((entry) => entry.emoji === emojiKey)?.roleId ?? null;
}

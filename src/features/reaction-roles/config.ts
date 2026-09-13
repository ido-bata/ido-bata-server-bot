import type { CategoryRule } from "../role-category-menu/index.js";
import { findCategoryRoleId, validateCategoryRule } from "../role-category-menu/index.js";

export type EmojiLike = {
  id: string | null;
  name: string | null;
};

export type ReactionRoleRule = {
  messageId: string;
  emoji: string;
  roleId: string;
};

// Replace these placeholder values with your actual Discord IDs.
export const reactionRoleRules: ReactionRoleRule[] = [
  {
    messageId: "1481188592448438355",
    emoji: "🔥",
    roleId: "1326148759150788691",
  },
];

/**
 * Category groups let a single message expose multiple emoji → role pairs.
 * Each entry is validated at module load — invalid rules throw so the bot
 * refuses to start with a broken config.
 */
export const reactionRoleCategories: CategoryRule[] = [];

export function toEmojiKey(emoji: EmojiLike): string | null {
  if (emoji.id) {
    return emoji.id;
  }

  return emoji.name;
}

/**
 * Match a reaction against either a legacy single-role rule or a category rule.
 * Returns the role to apply, or null when the reaction should be ignored.
 *
 * Single-role rules win when both match — that mirrors the historical behavior
 * and keeps operator-authored overrides authoritative over category defaults.
 */
export function findReactionRoleMatch(
  messageId: string,
  emoji: EmojiLike,
): { roleId: string; category: CategoryRule | null } | null {
  const single = findReactionRoleRule(messageId, emoji);
  if (single) {
    return { roleId: single.roleId, category: null };
  }

  const emojiKey = toEmojiKey(emoji);
  const category = reactionRoleCategories.find((rule) => rule.messageId === messageId);
  if (!category) {
    return null;
  }

  const roleId = findCategoryRoleId(category, emojiKey);
  if (!roleId) {
    return null;
  }

  return { roleId, category };
}

export function findReactionRoleRule(messageId: string, emoji: EmojiLike): ReactionRoleRule | null {
  const emojiKey = toEmojiKey(emoji);

  if (!emojiKey) {
    return null;
  }

  return (
    reactionRoleRules.find((rule) => rule.messageId === messageId && rule.emoji === emojiKey) ??
    null
  );
}

// Eagerly validate configured categories at module load. Throwing here means
// `bun run start` / `bun run dev` fails fast on bad config rather than at
// first reaction event.
for (const rule of reactionRoleCategories) {
  const errors = validateCategoryRule(rule);
  if (errors.length > 0) {
    throw new Error(
      `Invalid reaction-role category for message ${rule.messageId}: ${errors
        .map((e) => e.message)
        .join("; ")}`,
    );
  }
}

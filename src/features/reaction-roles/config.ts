export type EmojiLike = {
  id: string | null;
  name: string | null;
};

export type ReactionRoleRule = {
  messageId: string;
  emoji: string;
  roleId: string;
  // When true, the role is also exposed through the `/role assign` and
  // `/role remove` slash commands. Defaults to false so legacy rules keep
  // their original reaction-only behaviour.
  assignableViaSlash?: boolean;
};

// Replace these placeholder values with your actual Discord IDs.
export const reactionRoleRules: ReactionRoleRule[] = [
  {
    messageId: "1481188592448438355",
    emoji: "🔥",
    roleId: "1326148759150788691",
    assignableViaSlash: true,
  },
];

export function toEmojiKey(emoji: EmojiLike): string | null {
  if (emoji.id) {
    return emoji.id;
  }

  return emoji.name;
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

export function findReactionRoleRuleByRoleId(roleId: string): ReactionRoleRule | null {
  return reactionRoleRules.find((rule) => rule.roleId === roleId) ?? null;
}

export function isSlashAssignable(rule: ReactionRoleRule | null): boolean {
  return Boolean(rule?.assignableViaSlash);
}
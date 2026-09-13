import { describe, expect, it } from "vitest";

import {
  findReactionRoleMatch,
  findReactionRoleRule,
  reactionRoleRules,
  toEmojiKey,
} from "../src/features/reaction-roles/config.js";

describe("reaction role config", () => {
  it("normalizes unicode emoji keys", () => {
    expect(toEmojiKey({ name: "🔥", id: null })).toBe("🔥");
  });

  it("normalizes custom emoji keys", () => {
    expect(toEmojiKey({ name: "staff", id: "123456" })).toBe("123456");
  });

  it("finds a configured rule by message id and emoji", () => {
    const targetRule = reactionRoleRules[0];
    const rule = findReactionRoleRule(targetRule.messageId, {
      name: targetRule.emoji,
      id: null,
    });

    expect(rule).toEqual(targetRule);
  });

  it("returns null when no rule matches", () => {
    const rule = findReactionRoleRule("message-1", {
      name: "✅",
      id: null,
    });

    expect(rule).toBeNull();
  });

  describe("findReactionRoleMatch", () => {
    it("returns the single-rule role when no category is configured", () => {
      const targetRule = reactionRoleRules[0];
      const match = findReactionRoleMatch(targetRule.messageId, {
        name: targetRule.emoji,
        id: null,
      });
      expect(match).toEqual({ roleId: targetRule.roleId, category: null });
    });

    it("returns null when neither single nor category matches", () => {
      const match = findReactionRoleMatch("message-unknown", {
        name: "🛑",
        id: null,
      });
      expect(match).toBeNull();
    });
  });
});

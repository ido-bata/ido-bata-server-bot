import { describe, expect, it } from "vitest";

import {
  findReactionRoleRuleByRoleId,
  isSlashAssignable,
  reactionRoleRules,
} from "../src/features/reaction-roles/config.js";

describe("reaction-roles config (slash extension)", () => {
  it("defaults assignableViaSlash to false for legacy rules", () => {
    const allRules = reactionRoleRules;
    // The shipped rule list contains at least one slash-assignable rule by
    // default, but the helper must work whether the field is present or not.
    const sample = allRules[0];
    expect(sample).toBeDefined();

    const synthetic = { messageId: "m", emoji: "🔥", roleId: "r" } as const;
    expect(isSlashAssignable(synthetic)).toBe(false);
    expect(isSlashAssignable({ ...synthetic, assignableViaSlash: true })).toBe(true);
    expect(isSlashAssignable(null)).toBe(false);
  });

  it("finds a rule by roleId", () => {
    const target = reactionRoleRules.find((rule) => rule.roleId);
    if (!target) {
      return;
    }

    const found = findReactionRoleRuleByRoleId(target.roleId);
    expect(found).toEqual(target);
  });

  it("returns null when no rule matches the roleId", () => {
    const found = findReactionRoleRuleByRoleId("role-does-not-exist");
    expect(found).toBeNull();
  });
});
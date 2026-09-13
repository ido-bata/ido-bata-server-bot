import { describe, expect, it } from "vitest";

import {
  type CategoryRule,
  DISCORD_MAX_REACTIONS_PER_MESSAGE,
  findCategoryRoleId,
  formatCategoryMessage,
  validateCategoryRule,
} from "../src/features/role-category-menu/index.js";

const baseRule: CategoryRule = {
  messageId: "msg-1",
  description: "Pick your interests",
  emojis: [
    { emoji: "🎮", roleId: "111" },
    { emoji: "🎵", roleId: "222" },
  ],
};

describe("role-category-menu", () => {
  describe("validateCategoryRule", () => {
    it("accepts a rule within Discord's 20-emoji limit", () => {
      const rule: CategoryRule = {
        ...baseRule,
        emojis: Array.from({ length: DISCORD_MAX_REACTIONS_PER_MESSAGE }, (_, i) => ({
          emoji: `e${i}`,
          roleId: `r${i}`,
        })),
      };

      expect(validateCategoryRule(rule)).toEqual([]);
    });

    it("rejects empty emoji lists", () => {
      const errors = validateCategoryRule({ ...baseRule, emojis: [] });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("empty");
    });

    it("rejects rules that exceed the Discord 20-reaction cap", () => {
      const rule: CategoryRule = {
        ...baseRule,
        emojis: Array.from({ length: DISCORD_MAX_REACTIONS_PER_MESSAGE + 1 }, (_, i) => ({
          emoji: `e${i}`,
          roleId: `r${i}`,
        })),
      };

      const errors = validateCategoryRule(rule);
      expect(errors.some((e) => e.code === "too_many")).toBe(true);
    });

    it("flags duplicate emoji keys", () => {
      const errors = validateCategoryRule({
        ...baseRule,
        emojis: [
          { emoji: "🎮", roleId: "111" },
          { emoji: "🎮", roleId: "222" },
        ],
      });
      expect(errors.some((e) => e.code === "duplicate_emoji")).toBe(true);
    });

    it("flags duplicate role ids", () => {
      const errors = validateCategoryRule({
        ...baseRule,
        emojis: [
          { emoji: "🎮", roleId: "111" },
          { emoji: "🎵", roleId: "111" },
        ],
      });
      expect(errors.some((e) => e.code === "duplicate_role")).toBe(true);
    });

    it("flags missing emoji and role id", () => {
      const errors = validateCategoryRule({
        ...baseRule,
        emojis: [{ emoji: "", roleId: "" }],
      });
      expect(errors.some((e) => e.code === "missing_emoji")).toBe(true);
      expect(errors.some((e) => e.code === "missing_role")).toBe(true);
    });
  });

  describe("formatCategoryMessage", () => {
    it("renders the description followed by an emoji legend", () => {
      const out = formatCategoryMessage(baseRule);
      expect(out.startsWith("Pick your interests\n\n")).toBe(true);
      expect(out).toContain("🎮 — <@&111>");
      expect(out).toContain("🎵 — <@&222>");
    });
  });

  describe("findCategoryRoleId", () => {
    it("returns the role mapped to the emoji key", () => {
      expect(findCategoryRoleId(baseRule, "🎮")).toBe("111");
      expect(findCategoryRoleId(baseRule, "🎵")).toBe("222");
    });

    it("returns null when the emoji is unknown", () => {
      expect(findCategoryRoleId(baseRule, "🛑")).toBeNull();
    });

    it("returns null when the emoji key is null", () => {
      expect(findCategoryRoleId(baseRule, null)).toBeNull();
    });
  });
});

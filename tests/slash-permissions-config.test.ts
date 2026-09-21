import { describe, expect, it } from "vitest";

import {
  DEFAULT_SLASH_PERMISSION_LEVEL,
  findSlashPermissionRule,
  resolveSlashPermissionLevel,
  slashPermissionRules,
  validateSlashPermissionRules,
} from "../src/features/slash-permissions/config.js";

describe("slash permission config", () => {
  it("exposes a deterministic, fully-populated rule list", () => {
    expect(slashPermissionRules.length).toBeGreaterThan(0);
    for (const rule of slashPermissionRules) {
      expect(rule.commandName.length).toBeGreaterThan(0);
      expect(rule.reason.length).toBeGreaterThan(0);
    }
  });

  it("looks up rules case-insensitively", () => {
    const rule = slashPermissionRules[0];
    if (!rule) {
      throw new Error("expected at least one slash permission rule");
    }

    expect(findSlashPermissionRule(rule.commandName.toUpperCase())).toEqual(rule);
    expect(findSlashPermissionRule("never-registered")).toBeUndefined();
  });

  it("applies the project default when a command has no explicit rule", () => {
    expect(resolveSlashPermissionLevel("not-a-real-command")).toBe(DEFAULT_SLASH_PERMISSION_LEVEL);
  });

  it("validates the shipped rule list on import", () => {
    // Reaching this assertion means `validateSlashPermissionRules` ran during
    // module load and did not throw. Re-run it explicitly to lock the
    // behaviour down.
    expect(() => validateSlashPermissionRules(slashPermissionRules)).not.toThrow();
  });

  it("rejects duplicate rule entries", () => {
    const rule = slashPermissionRules[0];
    if (!rule) {
      throw new Error("expected at least one slash permission rule");
    }

    expect(() =>
      validateSlashPermissionRules([rule, { ...rule, reason: "duplicated on purpose" }]),
    ).toThrow(/duplicate rule/i);
  });

  it("rejects unknown permission levels", () => {
    expect(() =>
      validateSlashPermissionRules([
        {
          commandName: "rogue",
          level: "view_audit_log" as never,
          reason: "should fail validation",
        },
      ]),
    ).toThrow(/unknown level/i);
  });

  it("rejects rules without a reason", () => {
    expect(() =>
      validateSlashPermissionRules([
        {
          commandName: "no-reason",
          level: "manage_messages",
          reason: "",
        },
      ]),
    ).toThrow(/missing a reason/i);
  });

  it("rejects rules without a command name", () => {
    expect(() =>
      validateSlashPermissionRules([
        {
          commandName: "",
          level: "manage_messages",
          reason: "missing name",
        },
      ]),
    ).toThrow(/missing commandName/i);
  });
});

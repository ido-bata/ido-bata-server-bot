import { describe, expect, it, vi } from "vitest";

import { performRoleAssignment, replyForResult } from "../src/features/role-slash/commands.js";
import { createRoleSlashCommandRegistry } from "../src/features/role-slash/registry.js";
import type { RoleAction, RoleAuditEntry, RoleManagerLike } from "../src/features/role-slash/types.js";

function createRoleManager() {
  const add = vi.fn(async (roleId: string) => {
    // silence unused-arg lint while keeping parameter for runtime contract
    return roleId;
  });
  const remove = vi.fn(async (roleId: string) => {
    return roleId;
  });
  const manager: RoleManagerLike = { add, remove };
  return { manager, add, remove };
}

describe("role-slash commands", () => {
  it("assigns a role when the rule is slash-assignable", async () => {
    const { manager, add, remove } = createRoleManager();
    const result = await performRoleAssignment(
      "assign",
      { guildId: "guild-1", userId: "user-1", roleId: "role-1" },
      {
        findRuleByRoleId: (roleId) => ({ roleId, assignableViaSlash: true }),
        hasRole: async () => false,
        withMemberRoleManager: async (_guildId, _userId, run) => run(manager),
      },
    );

    expect(result).toEqual({ ok: true, action: "assign", roleId: "role-1" });
    expect(add).toHaveBeenCalledWith("role-1");
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes a role when the rule is slash-assignable", async () => {
    const { manager, add, remove } = createRoleManager();
    const result = await performRoleAssignment(
      "remove",
      { guildId: "guild-1", userId: "user-1", roleId: "role-1" },
      {
        findRuleByRoleId: (roleId) => ({ roleId, assignableViaSlash: true }),
        hasRole: async () => true,
        withMemberRoleManager: async (_guildId, _userId, run) => run(manager),
      },
    );

    expect(result).toEqual({ ok: true, action: "remove", roleId: "role-1" });
    expect(remove).toHaveBeenCalledWith("role-1");
    expect(add).not.toHaveBeenCalled();
  });

  it("refuses to assign a role that is not slash-assignable", async () => {
    const { manager, add } = createRoleManager();
    const result = await performRoleAssignment(
      "assign",
      { guildId: "guild-1", userId: "user-1", roleId: "role-locked" },
      {
        findRuleByRoleId: () => null,
        withMemberRoleManager: async (_guildId, _userId, run) => run(manager),
      },
    );

    expect(result).toEqual({ ok: false, reason: "not_assignable" });
    expect(add).not.toHaveBeenCalled();
  });

  it("refuses to remove a role the user does not have", async () => {
    const { manager, remove } = createRoleManager();
    const result = await performRoleAssignment(
      "remove",
      { guildId: "guild-1", userId: "user-1", roleId: "role-1" },
      {
        findRuleByRoleId: () => ({ roleId: "role-1", assignableViaSlash: true }),
        hasRole: async () => false,
        withMemberRoleManager: async (_guildId, _userId, run) => run(manager),
      },
    );

    expect(result).toEqual({ ok: false, reason: "no_change" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("returns no_change when the user already has the role on assign", async () => {
    const { manager, add } = createRoleManager();
    const result = await performRoleAssignment(
      "assign",
      { guildId: "guild-1", userId: "user-1", roleId: "role-1" },
      {
        findRuleByRoleId: () => ({ roleId: "role-1", assignableViaSlash: true }),
        hasRole: async () => true,
        withMemberRoleManager: async (_guildId, _userId, run) => run(manager),
      },
    );

    expect(result).toEqual({ ok: false, reason: "no_change" });
    expect(add).not.toHaveBeenCalled();
  });

  it("reports role_not_found when withMemberRoleManager returns undefined", async () => {
    const { manager } = createRoleManager();
    const result = await performRoleAssignment(
      "assign",
      { guildId: "guild-1", userId: "user-1", roleId: "role-1" },
      {
        findRuleByRoleId: () => ({ roleId: "role-1", assignableViaSlash: true }),
        hasRole: async () => false,
        withMemberRoleManager: async () => undefined,
      },
    );

    expect(result).toEqual({ ok: false, reason: "role_not_found" });
    expect(manager.add).not.toHaveBeenCalled();
  });

  it("forwards audit entries with success result", async () => {
    const { manager } = createRoleManager();
    const audit = vi.fn();
    const result = await performRoleAssignment(
      "assign",
      { guildId: "guild-1", userId: "user-1", roleId: "role-1" },
      {
        findRuleByRoleId: (roleId) => ({ roleId, assignableViaSlash: true }),
        hasRole: async () => false,
        withMemberRoleManager: async (_guildId, _userId, run) => run(manager),
        audit,
      },
    );

    expect(result.ok).toBe(true);
    expect(audit).toHaveBeenCalledWith({
      action: "assign",
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      result: "success",
      reason: undefined,
    } satisfies RoleAuditEntry);
  });

  it("forwards audit entries with skipped reason on no_change", async () => {
    const audit = vi.fn();
    await performRoleAssignment(
      "assign",
      { guildId: "guild-1", userId: "user-1", roleId: "role-1" },
      {
        findRuleByRoleId: () => ({ roleId: "role-1", assignableViaSlash: true }),
        hasRole: async () => true,
        withMemberRoleManager: async () => {
          throw new Error("should not run");
        },
        audit,
      },
    );

    expect(audit).toHaveBeenCalledWith({
      action: "assign",
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      result: "skipped",
      reason: "no_change",
    } satisfies RoleAuditEntry);
  });
});

describe("replyForResult", () => {
  it("renders an ephemeral success message for assign", () => {
    const reply = replyForResult(
      { ok: true, action: "assign", roleId: "role-1" },
      "role-1",
    );
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toContain("<@&role-1>");
    expect(reply.content).toContain("付与");
  });

  it("renders an ephemeral failure message for not_assignable", () => {
    const reply = replyForResult(
      { ok: false, reason: "not_assignable" },
      "role-1",
    );
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toMatch(/含まれていません/);
  });

  it("renders no_change distinctly from not_assignable", () => {
    const noChange = replyForResult(
      { ok: false, reason: "no_change" },
      "role-1",
    );
    const notAssignable = replyForResult(
      { ok: false, reason: "not_assignable" },
      "role-1",
    );
    expect(noChange.content).not.toBe(notAssignable.content);
  });
});

describe("role slash registry", () => {
  it("registers a /role command with assign/remove subcommands", () => {
    const registry = createRoleSlashCommandRegistry();
    const role = registry.find("role");
    expect(role).toBeDefined();
    expect(role?.name).toBe("role");
    expect(role?.description).toMatch(/リアクションロール/);

    const payload = role?.buildPayload();
    const json = payload && typeof (payload as { toJSON?: () => unknown }).toJSON === "function"
      ? (payload as { toJSON: () => { name: string; description: string; options?: Array<{ name: string }> } }).toJSON()
      : (payload as { name: string; description: string; options?: Array<{ name: string }> });

    expect(json.name).toBe("role");
    const subNames = json.options?.map((option) => option.name) ?? [];
    expect(subNames).toContain("assign");
    expect(subNames).toContain("remove");
  });

  it("returns undefined for unknown commands", () => {
    const registry = createRoleSlashCommandRegistry();
    expect(registry.find("does-not-exist")).toBeUndefined();
  });
});

// Ensures the handler factory accepts an action string without TS errors.
type _ExpectActionAssignable = RoleAction;
void (0 as unknown as _ExpectActionAssignable);
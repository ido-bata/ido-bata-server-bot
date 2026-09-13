import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it } from "vitest";
import { defaultMemberPermissionsFor } from "../src/features/slash-permissions/policy.js";
import {
  applyDefaultMemberPermissions,
  assertSlashPermission,
  evaluateSlashPermission,
  messageForDecision,
} from "../src/features/slash-permissions/runtime.js";

function makeInteraction(overrides: {
  commandName?: string;
  memberPermissions?: { has: (flag: bigint) => boolean } | null;
  inGuild?: boolean;
  replies?: { content: string; ephemeral?: boolean }[];
}) {
  const replies = overrides.replies ?? [];
  return {
    commandName: overrides.commandName ?? "ping",
    memberPermissions:
      overrides.memberPermissions === undefined ? { has: () => true } : overrides.memberPermissions,
    inGuild: () => overrides.inGuild ?? true,
    channelId: overrides.inGuild === false ? null : "1",
    user: { id: "user-1" },
    isRepliable: () => true,
    reply: async (options: { content: string; ephemeral?: boolean }) => {
      replies.push(options);
    },
    __replies: replies,
  };
}

describe("evaluateSlashPermission", () => {
  it("allows everyone-level commands regardless of permission bits", () => {
    const interaction = makeInteraction({
      commandName: "ping",
      memberPermissions: null,
    });
    const decision = evaluateSlashPermission(interaction);

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.level).toBe("everyone");
    }
  });

  it("denies moderator-level commands when the member lacks the bit", () => {
    const interaction = makeInteraction({
      commandName: "announce",
      memberPermissions: {
        has: (flag) => flag !== PermissionFlagsBits.ManageMessages,
      },
    });
    const decision = evaluateSlashPermission(interaction);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.level).toBe("manage_messages");
      expect(decision.reason).toBe("missing_permission");
    }
  });

  it("denies moderator-level commands outside of a guild", () => {
    const interaction = makeInteraction({
      commandName: "announce",
      memberPermissions: null,
      inGuild: false,
    });
    const decision = evaluateSlashPermission(interaction);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("dm_channel");
    }
  });

  it("applies the project default when the command is not in the rule list", () => {
    const interaction = makeInteraction({
      commandName: "future-command",
      memberPermissions: { has: () => false },
    });
    const decision = evaluateSlashPermission(interaction);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      // Default is `manage_messages`, so the bit the dispatcher would check
      // is the ManageMessages permission bit.
      expect(decision.level).toBe("manage_messages");
    }
  });
});

describe("assertSlashPermission", () => {
  it("returns the allowed decision without replying", async () => {
    const interaction = makeInteraction({ commandName: "ping" });
    const decision = await assertSlashPermission(interaction);

    expect(decision.allowed).toBe(true);
    expect(interaction.__replies).toEqual([]);
  });

  it("posts an ephemeral denial when the member lacks the bit", async () => {
    const interaction = makeInteraction({
      commandName: "audit",
      memberPermissions: { has: () => false },
    });
    const decision = await assertSlashPermission(interaction);

    expect(decision.allowed).toBe(false);
    expect(interaction.__replies).toEqual([
      expect.objectContaining({ ephemeral: true, content: expect.any(String) }),
    ]);
    expect(interaction.__replies[0]?.content).toBe(
      messageForDecision({
        allowed: false,
        level: "administrator",
        reason: "missing_permission",
      }),
    );
  });
});

describe("applyDefaultMemberPermissions", () => {
  it("writes the decimal permission bit into a plain payload object", () => {
    const payload = { name: "ping", description: "pong" };
    const next = applyDefaultMemberPermissions(payload, "manage_channels");

    expect(next.default_member_permissions).toBe(defaultMemberPermissionsFor("manage_channels"));
    expect(next.name).toBe("ping");
  });

  it("preserves builder-shaped payloads (no toJSON call)", () => {
    const calls: unknown[] = [];
    const builder = {
      toJSON: () => {
        calls.push("toJSON");
        return { name: "audit" };
      },
    };
    const next = applyDefaultMemberPermissions(builder, "administrator");

    expect(next.default_member_permissions).toBe(defaultMemberPermissionsFor("administrator"));
    expect(calls).toEqual([]);
  });

  it("rejects unknown permission levels", () => {
    expect(() =>
      applyDefaultMemberPermissions({ name: "rogue" }, "view_audit_log" as never),
    ).toThrow(/unknown slash permission level/i);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { createRoleSlashHandler } from "../src/features/role-slash/handler.js";
import type { RoleManagerLike } from "../src/features/role-slash/types.js";

type InteractionOverrides = Partial<{
  isChatInputCommand: () => boolean;
  isRepliable: () => boolean;
  commandName: string;
  reply: (options: { content: string; ephemeral?: boolean }) => Promise<unknown>;
  guildId: string;
  userId: string;
  roleId: string;
  subcommand: string;
}>;

function makeInteraction(overrides: InteractionOverrides = {}) {
  const reply = vi.fn<(options: { content: string; ephemeral?: boolean }) => Promise<unknown>>(
    async () => undefined,
  );
  const interaction = {
    isChatInputCommand: overrides.isChatInputCommand ?? (() => true),
    isRepliable: overrides.isRepliable ?? (() => true),
    commandName: overrides.commandName ?? "role",
    guildId: overrides.guildId ?? "guild-1",
    user: { id: overrides.userId ?? "user-1" },
    client: {},
    options: {
      getSubcommand: () => overrides.subcommand ?? "assign",
      get: (name: string, required: boolean) => {
        void name;
        void required;
        return { value: overrides.roleId ?? "role-1" };
      },
    },
    reply: overrides.reply ?? reply,
  };
  return { interaction, reply };
}

function firstReply(
  reply: Mock<(options: { content: string; ephemeral?: boolean }) => Promise<unknown>>,
): { content: string; ephemeral?: boolean } {
  expect(reply.mock.calls.length).toBeGreaterThan(0);
  const arg = reply.mock.calls[0]?.[0];
  if (!arg) {
    throw new Error("expected reply to be called");
  }
  return arg;
}

function makeRoleManager() {
  const add = vi.fn<(roleId: string) => Promise<string>>((roleId: string) =>
    Promise.resolve(roleId),
  );
  const remove = vi.fn<(roleId: string) => Promise<string>>((roleId: string) =>
    Promise.resolve(roleId),
  );
  const manager: RoleManagerLike = { add, remove };
  return { manager, add, remove };
}

describe("role-slash handler", () => {
  it("replies unknown for unregistered commands", async () => {
    const { interaction, reply } = makeInteraction({ commandName: "missing" });
    const handler = createRoleSlashHandler();

    await handler.handleInteraction(interaction);

    expect(reply).toHaveBeenCalledWith({ content: "unknown command", ephemeral: true });
  });

  it("ignores interactions that are not chat input commands", async () => {
    const { interaction, reply } = makeInteraction({
      isChatInputCommand: () => false,
    });
    const handler = createRoleSlashHandler();

    await handler.handleInteraction(interaction);

    expect(reply).not.toHaveBeenCalled();
  });

  it("assigns a role via slash and replies with success", async () => {
    const { interaction, reply } = makeInteraction({ subcommand: "assign", roleId: "role-1" });
    const { manager, add } = makeRoleManager();
    const handler = createRoleSlashHandler({
      findRuleByRoleId: (roleId) => ({ roleId, assignableViaSlash: true }),
      hasRole: async () => false,
      withMemberRoleManager: async (_guildId, _userId, run) => run(manager),
    });

    await handler.handleInteraction(interaction);

    expect(add).toHaveBeenCalledWith("role-1");
    expect(reply).toHaveBeenCalledTimes(1);
    const message = firstReply(reply);
    expect(message.content).toContain("付与");
    expect(message.ephemeral).toBe(true);
  });

  it("removes a role via slash and replies with success", async () => {
    const { interaction, reply } = makeInteraction({ subcommand: "remove", roleId: "role-1" });
    const { manager, remove } = makeRoleManager();
    const handler = createRoleSlashHandler({
      findRuleByRoleId: (roleId) => ({ roleId, assignableViaSlash: true }),
      hasRole: async () => true,
      withMemberRoleManager: async (_guildId, _userId, run) => run(manager),
    });

    await handler.handleInteraction(interaction);

    expect(remove).toHaveBeenCalledWith("role-1");
    const message = firstReply(reply);
    expect(message.content).toContain("解除");
  });

  it("replies with not_assignable when the role is not configured for slash", async () => {
    const { interaction, reply } = makeInteraction({ subcommand: "assign", roleId: "role-locked" });
    const { manager, add } = makeRoleManager();
    const handler = createRoleSlashHandler({
      findRuleByRoleId: () => null,
      hasRole: async () => false,
      withMemberRoleManager: async (_guildId, _userId, run) => run(manager),
    });

    await handler.handleInteraction(interaction);

    expect(add).not.toHaveBeenCalled();
    const message = firstReply(reply);
    expect(message.content).toMatch(/含まれていません/);
  });

  it("replies with no_change when the user already has the role on assign", async () => {
    const { interaction, reply } = makeInteraction({ subcommand: "assign", roleId: "role-1" });
    const { manager, add } = makeRoleManager();
    const handler = createRoleSlashHandler({
      findRuleByRoleId: (roleId) => ({ roleId, assignableViaSlash: true }),
      hasRole: async () => true,
      withMemberRoleManager: async (_guildId, _userId, run) => run(manager),
    });

    await handler.handleInteraction(interaction);

    expect(add).not.toHaveBeenCalled();
    const message = firstReply(reply);
    expect(message.content).toMatch(/変化はありません/);
  });

  it("respects a custom interaction resolver", async () => {
    const realInteraction = makeInteraction({ roleId: "role-1", subcommand: "assign" });
    const { manager, add } = makeRoleManager();
    const handler = createRoleSlashHandler({
      resolveInteraction: () => realInteraction.interaction,
      findRuleByRoleId: (roleId) => ({ roleId, assignableViaSlash: true }),
      hasRole: async () => false,
      withMemberRoleManager: async (_guildId, _userId, run) => run(manager),
    });

    await handler.handleInteraction({});

    expect(add).toHaveBeenCalledWith("role-1");
  });
});
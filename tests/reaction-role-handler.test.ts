import { describe, expect, it, vi } from "vitest";

import { createReactionRoleHandler } from "../src/features/reaction-roles/handler.js";

describe("reaction role handler", () => {
  it("adds a role when a matching single-rule reaction is added", async () => {
    const addRole = vi.fn(async () => undefined);
    const removeRole = vi.fn(async () => undefined);
    const handler = createReactionRoleHandler({
      findRule: () => ({
        roleId: "role-fire",
        category: null,
      }),
      withMemberRoleManager: async (_guildId, _userId, run) =>
        run({ add: addRole, remove: removeRole }),
    });

    await handler.onReactionAdd({
      messageId: "message-1",
      guildId: "guild-1",
      userId: "user-1",
      emoji: { name: "🔥", id: null },
    });

    expect(addRole).toHaveBeenCalledWith("role-fire");
    expect(removeRole).not.toHaveBeenCalled();
  });

  it("removes a role when a matching single-rule reaction is removed", async () => {
    const addRole = vi.fn(async () => undefined);
    const removeRole = vi.fn(async () => undefined);
    const handler = createReactionRoleHandler({
      findRule: () => ({
        roleId: "role-fire",
        category: null,
      }),
      withMemberRoleManager: async (_guildId, _userId, run) =>
        run({ add: addRole, remove: removeRole }),
    });

    await handler.onReactionRemove({
      messageId: "message-1",
      guildId: "guild-1",
      userId: "user-1",
      emoji: { name: "🔥", id: null },
    });

    expect(removeRole).toHaveBeenCalledWith("role-fire");
    expect(addRole).not.toHaveBeenCalled();
  });

  it("ignores reactions with no configured rule", async () => {
    const withMemberRoleManager = vi.fn();
    const handler = createReactionRoleHandler({
      findRule: () => null,
      withMemberRoleManager,
    });

    await handler.onReactionAdd({
      messageId: "message-1",
      guildId: "guild-1",
      userId: "user-1",
      emoji: { name: "🔥", id: null },
    });

    expect(withMemberRoleManager).not.toHaveBeenCalled();
  });

  it("applies the role mapped by a category rule", async () => {
    const addRole = vi.fn(async () => undefined);
    const removeRole = vi.fn(async () => undefined);
    const category = {
      messageId: "message-cat",
      description: "Pick your interests",
      emojis: [
        { emoji: "🎮", roleId: "role-games" },
        { emoji: "🎵", roleId: "role-music" },
      ],
    };
    const handler = createReactionRoleHandler({
      findRule: () => ({ roleId: "role-games", category }),
      withMemberRoleManager: async (_guildId, _userId, run) =>
        run({ add: addRole, remove: removeRole }),
    });

    await handler.onReactionAdd({
      messageId: "message-cat",
      guildId: "guild-1",
      userId: "user-1",
      emoji: { name: "🎮", id: null },
    });

    expect(addRole).toHaveBeenCalledTimes(1);
    expect(addRole).toHaveBeenCalledWith("role-games");
  });

  it("applies distinct roles when a member reacts to multiple category emoji", async () => {
    const addRole = vi.fn(async () => undefined);
    const removeRole = vi.fn(async () => undefined);
    const memberRoleManager = {
      add: addRole,
      remove: removeRole,
    };
    const category = {
      messageId: "message-cat",
      description: "Pick your interests",
      emojis: [
        { emoji: "🎮", roleId: "role-games" },
        { emoji: "🎵", roleId: "role-music" },
        { emoji: "📚", roleId: "role-books" },
      ],
    };
    const findRule = vi.fn(
      (_messageId: string, emoji: { name: string | null; id: string | null }) => {
        const entry = category.emojis.find((e) => e.emoji === emoji.name);
        return entry ? { roleId: entry.roleId, category } : null;
      },
    );
    const handler = createReactionRoleHandler({
      findRule,
      withMemberRoleManager: async (_guildId, _userId, run) => run(memberRoleManager),
    });

    // Simulate a member pressing 3 distinct emojis on the same category message.
    for (const emojiName of ["🎮", "🎵", "📚"]) {
      await handler.onReactionAdd({
        messageId: "message-cat",
        guildId: "guild-1",
        userId: "user-1",
        emoji: { name: emojiName, id: null },
      });
    }

    expect(addRole).toHaveBeenNthCalledWith(1, "role-games");
    expect(addRole).toHaveBeenNthCalledWith(2, "role-music");
    expect(addRole).toHaveBeenNthCalledWith(3, "role-books");
    expect(findRule).toHaveBeenCalledTimes(3);
  });
});

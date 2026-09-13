import type {
  Client,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User,
} from "discord.js";
import { Events } from "discord.js";

import type { CategoryRule } from "../role-category-menu/index.js";
import { type EmojiLike, findReactionRoleMatch } from "./config.js";

type RoleManagerLike = {
  add: (roleId: string) => Promise<unknown>;
  remove: (roleId: string) => Promise<unknown>;
};

type ReactionRoleEvent = {
  emoji: EmojiLike;
  guildId: string;
  messageId: string;
  userId: string;
};

export type ReactionRoleMatch = {
  roleId: string;
  category: CategoryRule | null;
};

type HandlerDependencies = {
  /**
   * Lookup seam. Defaults to `findReactionRoleMatch`, which honors both
   * single-role rules and category rules. Tests can supply a stub here.
   */
  findRule?: (messageId: string, emoji: EmojiLike) => ReactionRoleMatch | null;
  withMemberRoleManager?: <T>(
    guildId: string,
    userId: string,
    run: (roles: RoleManagerLike) => Promise<T>,
  ) => Promise<T | undefined>;
};

export function createReactionRoleHandler(deps: HandlerDependencies = {}) {
  const findRule = deps.findRule ?? findReactionRoleMatch;
  const withMemberRoleManager = deps.withMemberRoleManager;

  async function apply(event: ReactionRoleEvent, action: "add" | "remove") {
    const match = findRule(event.messageId, event.emoji);
    if (!match || !withMemberRoleManager) {
      return;
    }

    // Single fetch of the member's role manager per reaction event. When a
    // member presses multiple emojis on a category message, each reaction
    // event reuses this seam so the resulting role add/remove operations
    // happen against the same member snapshot.
    await withMemberRoleManager(event.guildId, event.userId, async (roles) => {
      await roles[action](match.roleId);
    });
  }

  return {
    onReactionAdd: (event: ReactionRoleEvent) => apply(event, "add"),
    onReactionRemove: (event: ReactionRoleEvent) => apply(event, "remove"),
  };
}

export function registerReactionRoleHandlers(client: Client): void {
  const handler = createReactionRoleHandler({
    withMemberRoleManager: async (guildId, userId, run) => {
      const guild = client.guilds.cache.get(guildId);

      if (!guild) {
        return undefined;
      }

      const member = await guild.members.fetch(userId);
      return run(member.roles);
    },
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    await handleDiscordReactionEvent(reaction, user, handler.onReactionAdd);
  });

  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    await handleDiscordReactionEvent(reaction, user, handler.onReactionRemove);
  });
}

async function handleDiscordReactionEvent(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  apply: (event: ReactionRoleEvent) => Promise<void>,
): Promise<void> {
  if (user.bot) {
    return;
  }

  const resolvedReaction = reaction.partial ? await reaction.fetch() : reaction;
  const guildId = resolvedReaction.message.guildId;

  if (!guildId) {
    return;
  }

  await apply({
    emoji: {
      id: resolvedReaction.emoji.id,
      name: resolvedReaction.emoji.name,
    },
    guildId,
    messageId: resolvedReaction.message.id,
    userId: user.id,
  });
}

import type {
  Client,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User,
} from "discord.js";
import { Events } from "discord.js";
import type { GuildListener } from "../multi-guild/listener.js";
import type { CategoryRule } from "../role-category-menu/index.js";
import {
  type EmojiLike,
  findReactionRoleMatch,
  findReactionRoleRule,
  type ReactionRoleRule,
} from "./config.js";

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

type ReactionRoleMatch = {
  roleId: string;
  category: CategoryRule | null;
};

type HandlerDependencies = {
  /**
   * Lookup seam. Defaults to a lookup that consults the per-guild rule map
   * populated by the listener's onMount/onUnmount and then falls back to the
   * module-level `findReactionRoleMatch` (which honors single-role rules and
   * category rules). Tests can supply a stub here.
   */
  findRule?: (messageId: string, emoji: EmojiLike) => ReactionRoleMatch | null;
  withMemberRoleManager?: <T>(
    guildId: string,
    userId: string,
    run: (roles: RoleManagerLike) => Promise<T>,
  ) => Promise<T | undefined>;
};

// Per-guild rule registry, populated by the listener's onMount/onUnmount and
// consumed by `handleReactionAdd` / `handleReactionRemove`. Sharing a single
// map at module scope is fine because the bot runs one Discord client per
// process.
const guildReactionRules = new Map<string, ReactionRoleRule[]>();

function defaultFindRule(messageId: string, emoji: EmojiLike): ReactionRoleMatch | null {
  // Per-guild override wins. The multi-guild listener keeps this map in sync
  // with the active GuildConfig, so a freshly mounted guild's rules take effect
  // without restarting the bot.
  for (const rules of guildReactionRules.values()) {
    const rule = findReactionRoleRule(rules, messageId, emoji);
    if (rule) {
      return { roleId: rule.roleId, category: null };
    }
  }
  return findReactionRoleMatch(messageId, emoji);
}

export function createReactionRoleHandler(deps: HandlerDependencies = {}) {
  const findRule = deps.findRule ?? defaultFindRule;
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

/**
 * Listener that maintains the per-guild reaction-role rule registry. Register
 * the listener with a `GuildRegistry` so that whenever a guild is mounted or
 * reloaded, its current rules are reflected in the lookups performed by
 * `handleReactionAdd` / `handleReactionRemove`.
 */
export function createReactionRoleListener(): GuildListener {
  return {
    id: "reaction-roles",
    async onMount(ctx) {
      guildReactionRules.set(ctx.guildId, ctx.config.reactionRoles);
    },
    async onUnmount({ guildId }) {
      guildReactionRules.delete(guildId);
    },
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

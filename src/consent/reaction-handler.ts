import type { ConsentScope } from "./scopes.js";
import type { ConsentService } from "./service.js";
import type { ReactionTarget } from "./types.js";

type Log = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

/**
 * Dependencies for `createReactionHandler`. The handler is intentionally
 * driven by data — the `targets` list tells it which messages are consent
 * messages, and the `emojiToScope` map tells it which scope each emoji
 * represents. The handler is a no-op for any reaction outside these two
 * sets so the bot's behaviour on unrelated messages stays unchanged.
 */
export type ReactionHandlerDeps = {
  fetcher: {
    fetchMessageReactions(target: ReactionTarget): Promise<Set<string>>;
  };
  service: ConsentService;
  targets: ReadonlyArray<ReactionTarget>;
  emojiToScope: ReadonlyMap<string, ConsentScope>;
  log?: Log;
};

export type ReactionHandler = {
  onAdd: (
    messageId: string,
    channelId: string,
    guildId: string,
    userId: string,
    emoji: string,
    isBot: boolean,
  ) => Promise<void>;
  onRemove: (
    messageId: string,
    channelId: string,
    guildId: string,
    userId: string,
    emoji: string,
    isBot: boolean,
  ) => Promise<void>;
};

const noopLog: Log = {
  info: () => undefined,
  warn: () => undefined,
};

function targetMatches(
  target: ReactionTarget,
  messageId: string,
  channelId: string,
  guildId: string,
  emoji: string,
): boolean {
  return (
    target.messageId === messageId &&
    target.channelId === channelId &&
    target.guildId === guildId &&
    target.emoji === emoji
  );
}

export function createReactionHandler(deps: ReactionHandlerDeps): ReactionHandler {
  const log = deps.log ?? noopLog;

  async function onAdd(
    messageId: string,
    channelId: string,
    guildId: string,
    userId: string,
    emoji: string,
    isBot: boolean,
  ): Promise<void> {
    if (isBot) {
      return;
    }
    if (
      !deps.targets.some((target) => targetMatches(target, messageId, channelId, guildId, emoji))
    ) {
      return;
    }
    const scope = deps.emojiToScope.get(emoji);
    if (!scope) {
      log.warn(`reaction-handler: emoji ${emoji} not mapped to a consent scope`);
      return;
    }
    try {
      await deps.service.grant({
        subjectId: userId,
        scope,
        source: { guildId, channelId, messageId, emoji },
      });
    } catch (error) {
      log.warn(
        `reaction-handler: grant failed for user=${userId} scope=${scope} message=${messageId}: ${formatError(error)}`,
      );
    }
  }

  async function onRemove(
    messageId: string,
    channelId: string,
    guildId: string,
    userId: string,
    emoji: string,
    isBot: boolean,
  ): Promise<void> {
    if (isBot) {
      return;
    }
    if (
      !deps.targets.some((target) => targetMatches(target, messageId, channelId, guildId, emoji))
    ) {
      return;
    }
    const scope = deps.emojiToScope.get(emoji);
    if (!scope) {
      log.warn(`reaction-handler: emoji ${emoji} not mapped to a consent scope`);
      return;
    }
    try {
      await deps.service.revoke(userId, scope);
    } catch (error) {
      log.warn(
        `reaction-handler: revoke failed for user=${userId} scope=${scope} message=${messageId}: ${formatError(error)}`,
      );
    }
  }

  return { onAdd, onRemove };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

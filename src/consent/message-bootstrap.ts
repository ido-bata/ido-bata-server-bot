import type { Client, Message, TextChannel } from "discord.js";

import type { ConsentConfig } from "./config.js";
import type { ConsentLogger } from "./logger.js";
import type { ReactionFetcher } from "./service.js";
import type { ReactionTarget } from "./types.js";

export const CONSENT_MESSAGE_MARKER = "ido-bata consent settings";

const SCOPE_LABELS: Record<string, string> = {
  "activity-history": "活動履歴 — Timekeeper、リマインダー、投票など",
  "presence-history": "プレゼンス — ゲーム、Spotify、VC 状態など",
  profile: "プロフィール — 誕生日など",
  "message-history": "メッセージ履歴 — メッセージを利用する機能",
};

type BootstrapDeps = {
  client: Client;
  config: ConsentConfig;
  logger?: ConsentLogger;
};

const noopLogger: ConsentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child() {
    return noopLogger;
  },
};

export function renderConsentMessage(config: ConsentConfig): string {
  const lines = [
    "**データ利用設定**",
    "",
    "ido-bata bot の機能で利用してよい情報を選択してください。",
    "リアクションを付けると該当項目への同意、外すと今後の収集を停止します。",
    "保存済みデータは `/privacy status` で確認し、`/privacy delete` で削除できます。",
    "",
  ];

  for (const [emoji, scope] of Object.entries(config.emojiToScope)) {
    lines.push(`${emoji} **${SCOPE_LABELS[scope] ?? scope}**`);
  }

  lines.push("");
  lines.push(`Policy: \`${config.policyVersion}\``);
  lines.push(`-# ${CONSENT_MESSAGE_MARKER}`);
  return lines.join("\n");
}

function isManagedConsentMessage(message: Message, botUserId: string): boolean {
  return message.author.id === botUserId && message.content.includes(CONSENT_MESSAGE_MARKER);
}

async function fetchConsentChannel(client: Client, config: ConsentConfig): Promise<TextChannel> {
  const channel = await client.channels.fetch(config.channelId);
  if (!channel?.isTextBased() || !("messages" in channel) || !("send" in channel)) {
    throw new Error(`Consent channel ${config.channelId} is not a message-capable text channel`);
  }
  if ("guildId" in channel && channel.guildId !== config.guildId) {
    throw new Error(
      `Consent channel ${config.channelId} belongs to guild ${channel.guildId}, expected ${config.guildId}`,
    );
  }
  return channel as TextChannel;
}

/**
 * Resolve the Discord message that acts as the consent UI.
 *
 * - Explicit CONSENT_MESSAGE_ID is treated as an operator override.
 * - Otherwise the latest bot-authored managed message is reused.
 * - If no managed message exists, the bot creates one.
 * - Bot-owned managed messages are edited to the current template/policy.
 * - Every configured scope emoji is added by the bot itself.
 *
 * The returned config always carries the resolved message id.
 */
export async function ensureConsentMessage(deps: BootstrapDeps): Promise<ConsentConfig> {
  const log = (deps.logger ?? noopLogger).child({ module: "consent-message-bootstrap" });
  const { client, config } = deps;

  if (!config.enabled) {
    return config;
  }
  const botUserId = client.user?.id;
  if (!botUserId) {
    throw new Error("Discord client user is unavailable while bootstrapping consent message");
  }

  const channel = await fetchConsentChannel(client, config);
  let message: Message | undefined;

  if (config.messageId) {
    try {
      message = await channel.messages.fetch(config.messageId);
    } catch (error) {
      log.error("configured consent message could not be fetched", {
        channelId: config.channelId,
        messageId: config.messageId,
        error: formatError(error),
      });
      throw new Error(
        `Configured consent message ${config.messageId} could not be fetched; refusing to create a replacement`,
        { cause: error },
      );
    }
  } else {
    let before: string | undefined;
    for (let page = 0; page < 10 && !message; page += 1) {
      const recent = await channel.messages.fetch(before ? { limit: 100, before } : { limit: 100 });
      message = recent.find((candidate) => isManagedConsentMessage(candidate, botUserId));
      if (message || recent.size < 100) {
        break;
      }
      before = recent.last()?.id;
      if (!before) {
        break;
      }
    }

    if (!message) {
      message = await channel.send(renderConsentMessage(config));
      log.info("created consent message", {
        channelId: config.channelId,
        messageId: message.id,
      });
    }
  }

  if (isManagedConsentMessage(message, botUserId)) {
    const expected = renderConsentMessage(config);
    if (message.content !== expected) {
      message = await message.edit(expected);
      log.info("updated managed consent message", {
        channelId: config.channelId,
        messageId: message.id,
      });
    }
  }

  for (const emoji of Object.keys(config.emojiToScope)) {
    await message.react(emoji);
  }

  return { ...config, messageId: message.id };
}

async function fetchTargetMessage(client: Client, target: ReactionTarget): Promise<Message> {
  const channel = await client.channels.fetch(target.channelId);
  if (!channel?.isTextBased() || !("messages" in channel)) {
    throw new Error(`Consent target channel ${target.channelId} is unavailable`);
  }
  return channel.messages.fetch(target.messageId);
}

/**
 * Discord-backed reaction fetcher used by startup reconciliation.
 * Bot accounts are filtered here; ConsentService keeps its own bot-id
 * guard as a second layer when configured.
 */
export function createDiscordReactionFetcher(client: Client): ReactionFetcher {
  return {
    async fetchMessageReactions(target): Promise<Set<string>> {
      const message = await fetchTargetMessage(client, target);
      const reaction =
        message.reactions.resolve(target.emoji) ??
        message.reactions.cache.find(
          (candidate) =>
            candidate.emoji.id === target.emoji || candidate.emoji.name === target.emoji,
        );

      if (!reaction) {
        return new Set<string>();
      }

      const userIds = new Set<string>();
      let after: string | undefined;
      while (true) {
        const users = await reaction.users.fetch({ limit: 100, after });
        for (const user of users.values()) {
          if (!user.bot) {
            userIds.add(user.id);
          }
        }
        if (users.size < 100) {
          break;
        }
        const last = users.last();
        if (!last || last.id === after) {
          break;
        }
        after = last.id;
      }
      return userIds;
    },
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

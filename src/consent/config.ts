import { type ConsentScope, DEFAULT_POLICY_VERSION, isConsentScope } from "./scopes.js";

/**
 * Runtime configuration for the consent registry.
 *
 * `enabled` becomes true when a guild + channel are configured. The
 * message id is optional: when omitted the bot bootstraps and maintains
 * its own consent message in the configured channel.
 */
export type ConsentConfig = {
  enabled: boolean;
  messageId: string;
  channelId: string;
  guildId: string;
  /** Emoji → scope mapping. The consent message should declare one emoji per scope. */
  emojiToScope: Record<string, ConsentScope>;
  /** Policy version the service treats as "current". */
  policyVersion: string;
};

export const DEFAULT_CONSENT_EMOJI_TO_SCOPE: Readonly<Record<string, ConsentScope>> = {
  "📊": "activity-history",
  "🟢": "presence-history",
  "👤": "profile",
  "💬": "message-history",
};

export type RawConsentEnv = {
  CONSENT_MESSAGE_ID?: string;
  CONSENT_CHANNEL_ID?: string;
  CONSENT_GUILD_ID?: string;
  CONSENT_EMOJI?: string;
  CONSENT_POLICY_VERSION?: string;
  DISCORD_GUILD_ID?: string;
};

/**
 * Read the consent config from raw env values. Invalid values are
 * logged and the resulting config falls back to a disabled state — the
 * bot still boots, but no consent message is recognised.
 */
export function readConsentConfig(env: RawConsentEnv): ConsentConfig {
  const policyVersion = (env.CONSENT_POLICY_VERSION ?? "").trim() || DEFAULT_POLICY_VERSION;
  const messageId = (env.CONSENT_MESSAGE_ID ?? "").trim();
  const channelId = (env.CONSENT_CHANNEL_ID ?? "").trim();
  const guildId = (env.CONSENT_GUILD_ID ?? "").trim() || (env.DISCORD_GUILD_ID ?? "").trim();

  if (channelId.length === 0 || guildId.length === 0) {
    return {
      enabled: false,
      messageId,
      channelId,
      guildId,
      emojiToScope: {},
      policyVersion,
    };
  }

  const emojiToScope = parseEmojiToScope(env.CONSENT_EMOJI);
  return {
    enabled: Object.keys(emojiToScope).length > 0,
    messageId,
    channelId,
    guildId,
    emojiToScope,
    policyVersion,
  };
}

/**
 * Parse `CONSENT_EMOJI` into a Record<emoji, scope>. When omitted, all
 * four v0.2.0 scopes receive a default emoji so CONSENT_CHANNEL_ID alone
 * is sufficient to bootstrap the consent UI. A single explicit emoji maps
 * to `profile`; comma-separated `<emoji>:<scope>` pairs customize it.
 */
export function parseEmojiToScope(raw: string | undefined): Record<string, ConsentScope> {
  if (!raw || raw.trim().length === 0) {
    return { ...DEFAULT_CONSENT_EMOJI_TO_SCOPE };
  }
  const result: Record<string, ConsentScope> = {};
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      // Bare emoji → default to "profile" so the simple
      // `CONSENT_EMOJI=✅` form keeps working.
      result[trimmed] = "profile";
      continue;
    }
    const emoji = trimmed.slice(0, colon).trim();
    const scope = trimmed.slice(colon + 1).trim();
    if (emoji.length === 0) {
      continue;
    }
    if (!isConsentScope(scope)) {
      // Unknown scopes are skipped silently here — operators see them
      // when the bot logs the resulting empty `emojiToScope` map.
      continue;
    }
    result[emoji] = scope;
  }
  return result;
}

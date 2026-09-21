import { type ConsentScope, DEFAULT_POLICY_VERSION, isConsentScope } from "./scopes.js";

/**
 * Runtime configuration for the consent registry.
 *
 * `enabled` flips to `false` when the operator has not configured a
 * `CONSENT_MESSAGE_ID`. In that mode the bot still starts but the
 * reaction handler is a no-op — no message is treated as a consent
 * source, no grants are issued.
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

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child() {
    return noopLogger;
  },
};
void noopLogger;

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

  if (messageId.length === 0) {
    return {
      enabled: false,
      messageId: "",
      channelId: "",
      guildId,
      emojiToScope: {},
      policyVersion,
    };
  }

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
    enabled: true,
    messageId,
    channelId,
    guildId,
    emojiToScope,
    policyVersion,
  };
}

/**
 * Parse `CONSENT_EMOJI` into a Record<emoji, scope>. Supports either a
 * single emoji (default → `profile`) or a comma-separated list of
 * `<emoji>:<scope>` pairs (`✅:profile, ⭐:activity-history`).
 */
export function parseEmojiToScope(raw: string | undefined): Record<string, ConsentScope> {
  if (!raw || raw.trim().length === 0) {
    return {};
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

export type ErrorForwarderConfig = {
  /** Discord channel id where error embeds are forwarded. Empty = log-only fallback. */
  channelId: string;
  /** Maximum embed description length, matching Discord's hard limit. */
  maxDescriptionLength: number;
  /** Maximum events with the same stack signature forwarded per window. */
  maxPerWindow: number;
  /** Window length in milliseconds for the per-stack rate limit. */
  windowMs: number;
  /** Whether `uncaughtException` is fatal — restart is required. */
  uncaughtExceptionIsFatal: boolean;
};

const DEFAULT_CHANNEL_ID = "";

export const errorForwarderConfig: ErrorForwarderConfig = {
  // Replace this placeholder with the real #bot-errors channel id once known.
  channelId: DEFAULT_CHANNEL_ID,
  maxDescriptionLength: 4096,
  maxPerWindow: 3,
  windowMs: 60_000,
  // Node's default behaviour: exit after uncaughtException unless the listener
  // overrides it. We mirror that and surface it through the embed + logger so
  // moderators know a manual restart is required.
  uncaughtExceptionIsFatal: true,
};

export function isErrorForwarderConfigured(config: ErrorForwarderConfig): boolean {
  return config.channelId.trim().length > 0;
}

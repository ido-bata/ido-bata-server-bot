export type MessageAuditConfig = {
  // Discord text channel ID where message edit / delete audit messages are forwarded.
  // Leave empty to disable the feature entirely.
  channelId: string;
};

// Replace this placeholder with the moderator-only audit channel ID.
// An empty channelId keeps the feature disabled (no-op on message events).
export const messageAuditConfig: MessageAuditConfig = {
  channelId: "",
};

export function isMessageAuditConfigured(config: MessageAuditConfig): boolean {
  return config.channelId.trim().length > 0;
}

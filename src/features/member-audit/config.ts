export type MemberAuditConfig = {
  // Discord text channel ID where join/leave audit messages are forwarded.
  // Leave empty to disable the feature entirely.
  channelId: string;
};

// Replace this placeholder with the moderator-only audit channel ID.
// An empty channelId keeps the feature disabled (no-op on join/leave events).
export const memberAuditConfig: MemberAuditConfig = {
  channelId: "",
};

export function isMemberAuditConfigured(config: MemberAuditConfig): boolean {
  return config.channelId.trim().length > 0;
}

import type { TextChannel } from "discord.js";

import type { RoleAuditEntry } from "./types.js";

export type AuditLogger = (entry: RoleAuditEntry) => Promise<void> | void;

// Pretty-prints a single audit entry. Kept as a pure function so tests can
// assert the output without spinning up Discord.
export function formatAuditEntry(entry: RoleAuditEntry): string {
  const reason = entry.reason ? ` reason=${entry.reason}` : "";
  return `[role-slash] action=${entry.action} guild=${entry.guildId} user=${entry.userId} role=${entry.roleId} result=${entry.result}${reason}`;
}

// Console logger used when no audit channel is configured. Suitable for
// staging and unit tests.
export function createConsoleAuditLogger(logger: {
  log: (message: string) => void;
} = console): AuditLogger {
  return (entry) => {
    logger.log(formatAuditEntry(entry));
  };
}

// Channel-backed logger. Resolves the channel lazily so it can be reused
// across many invocations without re-fetching.
export function createChannelAuditLogger(deps: {
  fetchChannel: (channelId: string) => Promise<unknown>;
  logger?: { warn: (message: string) => void };
}): (channelId: string | null) => AuditLogger {
  return (channelId) => {
    if (!channelId) {
      return createConsoleAuditLogger();
    }

    return async (entry) => {
      try {
        const channel = await deps.fetchChannel(channelId);
        if (!channel || !(channel as { isTextBased?: () => boolean }).isTextBased?.()) {
          return;
        }
        if (!("send" in (channel as object))) {
          return;
        }
        await (channel as TextChannel).send(formatAuditEntry(entry));
      } catch (error: unknown) {
        deps.logger?.warn(
          `[role-slash] failed to write audit entry: ${(error as Error)?.message ?? String(error)}`,
        );
      }
    };
  };
}
export type JoinAuditInput = {
  memberName: string;
  joinedAt: Date;
  accountCreatedAt: Date | null;
};

export type LeaveAuditInput = {
  memberName: string;
  leftAt: Date;
};

function toDiscordTimestamp(date: Date): string {
  return Math.floor(date.getTime() / 1000).toString();
}

// Format a join event for the audit log channel.
//
// Uses Discord's dynamic timestamp tokens (<t:SECONDS:F> / <t:SECONDS:R>) so the
// rendered time follows each viewer's locale, while keeping the raw event time
// anchored to the bot's clock. JST anchoring is achieved by the bot running in
// JST; the template itself does not hardcode a timezone offset.
export function formatJoinAudit(input: JoinAuditInput): string {
  const joinedToken = `<t:${toDiscordTimestamp(input.joinedAt)}:F>`;
  const base = `${joinedToken} 🟢 ${input.memberName} joined`;

  if (!input.accountCreatedAt) {
    return base;
  }

  const createdToken = `<t:${toDiscordTimestamp(input.accountCreatedAt)}:R>`;
  return `${base} (account created: ${createdToken})`;
}

// Format a leave event for the audit log channel.
export function formatLeaveAudit(input: LeaveAuditInput): string {
  const leftToken = `<t:${toDiscordTimestamp(input.leftAt)}:F>`;
  return `${leftToken} 🔴 ${input.memberName} left`;
}

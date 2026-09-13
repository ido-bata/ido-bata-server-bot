export type EditAuditInput = {
  authorId: string;
  authorName: string;
  channelId: string;
  messageId: string;
  // Content captured before the edit. Null when MessageContent intent is off
  // and the pre-edit payload arrived as a partial message with no content.
  before: string | null;
  // Content captured after the edit. Null when MessageContent intent is off.
  after: string | null;
  editedAt: Date;
};

export type DeleteAuditInput = {
  authorId: string;
  authorName: string;
  channelId: string;
  messageId: string;
  // Content snapshot before deletion. Null when MessageContent intent is off.
  content: string | null;
  // Attachment URLs to retain a forensic breadcrumb even when text is unavailable.
  attachmentUrls: string[];
  deletedAt: Date;
};

export type BulkDeleteAuditInput = {
  channelId: string;
  channelName: string;
  count: number;
  // Deduplicated list of authors present in the bulk-delete batch.
  authors: { id: string; name: string }[];
  deletedAt: Date;
};

function toDiscordTimestamp(date: Date): string {
  return Math.floor(date.getTime() / 1000).toString();
}

// Truncate text to keep the audit channel readable when a user pastes a wall
// of content. Discord will truncate embeds anyway, but capping at the source
// makes the test assertions deterministic.
const MAX_FIELD_LENGTH = 1800;

function clip(value: string | null): string {
  if (value === null) {
    return "_(text unavailable — MessageContent intent is not enabled)_";
  }
  if (value.length <= MAX_FIELD_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_FIELD_LENGTH)}\n…(truncated)`;
}

// Format a message edit event for the audit log channel.
//
// Before / after bodies are rendered on separate lines so moderators can diff
// them at a glance. Both sides collapse to a placeholder when the
// MessageContent intent is disabled, matching the privacy stance described in
// the issue body.
export function formatEditAudit(input: EditAuditInput): string {
  const editedToken = `<t:${toDiscordTimestamp(input.editedAt)}:F>`;
  const header = `${editedToken} ✏️ ${input.authorName} (${input.authorId}) edited message ${input.messageId} in <#${input.channelId}>`;
  const beforeLabel = "Before";
  const afterLabel = "After";
  const beforeBody = clip(input.before);
  const afterBody = clip(input.after);
  return `${header}\n**${beforeLabel}**\n${beforeBody}\n**${afterLabel}**\n${afterBody}`;
}

// Format a single message delete event for the audit log channel.
//
// Discord does not expose the channel after a delete lands, but the message
// ID is stable so we render a clickable channel reference. Attachments stay
// accessible via Discord's CDN even after the parent message is removed, so
// we list any URLs we have.
export function formatDeleteAudit(input: DeleteAuditInput): string {
  const deletedToken = `<t:${toDiscordTimestamp(input.deletedAt)}:F>`;
  const header = `${deletedToken} 🗑️ ${input.authorName} (${input.authorId}) — message ${input.messageId} deleted in <#${input.channelId}>`;

  const bodySection = `\nContent\n${clip(input.content)}`;

  if (input.attachmentUrls.length === 0) {
    return `${header}${bodySection}`;
  }

  const attachments = input.attachmentUrls.map((url) => `- ${url}`).join("\n");
  return `${header}${bodySection}\nAttachments\n${attachments}`;
}

// Format a bulk-delete summary for the audit log channel.
//
// We deliberately do NOT dump the full content of every removed message — that
// would balloon the channel and create a privacy concern. Moderators can pull
// the audit-log HTTP endpoint for the per-message trail; this summary gives
// them the shape (count + author roster) needed for triage.
export function formatBulkDeleteAudit(input: BulkDeleteAuditInput): string {
  const deletedToken = `<t:${toDiscordTimestamp(input.deletedAt)}:F>`;
  const header = `${deletedToken} 🧹 ${input.count} message${
    input.count === 1 ? "" : "s"
  } bulk-deleted in #${input.channelName} (<#${input.channelId}>)`;

  if (input.authors.length === 0) {
    return `${header}\n_(no resolvable authors — partial payloads)_`;
  }

  const roster = input.authors.map((author) => `- ${author.name} (${author.id})`).join("\n");
  return `${header}\nAuthors\n${roster}`;
}

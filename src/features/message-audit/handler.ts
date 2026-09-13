import type { Client, Message, PartialMessage, ReadonlyCollection, Snowflake } from "discord.js";
import { Events } from "discord.js";

import { isMessageAuditConfigured, type MessageAuditConfig } from "./config.js";
import { formatBulkDeleteAudit, formatDeleteAudit, formatEditAudit } from "./template.js";

export type MessageAuditDeps = {
  config: MessageAuditConfig;
  sendMessage?: (channelId: string, content: string) => Promise<void>;
  log?: (message: string) => void;
};

export type EditAuditEvent = {
  authorId: string;
  authorName: string;
  channelId: string;
  messageId: string;
  before: string | null;
  after: string | null;
  editedAt: Date;
  isBot: boolean;
};

export type DeleteAuditEvent = {
  authorId: string;
  authorName: string;
  channelId: string;
  messageId: string;
  content: string | null;
  attachmentUrls: string[];
  deletedAt: Date;
  isBot: boolean;
};

export type BulkDeleteAuditEvent = {
  channelId: string;
  channelName: string;
  count: number;
  authors: { id: string; name: string }[];
  deletedAt: Date;
};

export function createMessageAuditHandler(deps: MessageAuditDeps) {
  const { config } = deps;
  const sendMessage = deps.sendMessage;
  const log = deps.log ?? (() => {});
  const configured = isMessageAuditConfigured(config);

  async function postOrLog(channelId: string, content: string): Promise<void> {
    if (!sendMessage) {
      return;
    }

    try {
      await sendMessage(channelId, content);
    } catch (error) {
      log(
        `message-audit: failed to post audit message: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function onMessageUpdate(event: EditAuditEvent): Promise<void> {
    if (!configured || event.isBot) {
      return;
    }

    const content = formatEditAudit({
      authorId: event.authorId,
      authorName: event.authorName,
      channelId: event.channelId,
      messageId: event.messageId,
      before: event.before,
      after: event.after,
      editedAt: event.editedAt,
    });
    await postOrLog(config.channelId, content);
  }

  async function onMessageDelete(event: DeleteAuditEvent): Promise<void> {
    if (!configured || event.isBot) {
      return;
    }

    const content = formatDeleteAudit({
      authorId: event.authorId,
      authorName: event.authorName,
      channelId: event.channelId,
      messageId: event.messageId,
      content: event.content,
      attachmentUrls: event.attachmentUrls,
      deletedAt: event.deletedAt,
    });
    await postOrLog(config.channelId, content);
  }

  async function onMessageBulkDelete(event: BulkDeleteAuditEvent): Promise<void> {
    if (!configured) {
      return;
    }

    const content = formatBulkDeleteAudit({
      channelId: event.channelId,
      channelName: event.channelName,
      count: event.count,
      authors: event.authors,
      deletedAt: event.deletedAt,
    });
    await postOrLog(config.channelId, content);
  }

  return {
    isConfigured: () => configured,
    onMessageUpdate,
    onMessageDelete,
    onMessageBulkDelete,
  };
}

function isPartial(message: Message | PartialMessage): message is PartialMessage {
  return message.partial === true;
}

function resolveAttachmentUrls(message: Message | PartialMessage): string[] {
  // Discord exposes attachments as a Collection keyed by id; each entry has
  // .url (the CDN URL) and .proxyURL. Use .url because the proxy URL is
  // discarded when the attachment itself is purged.
  const size = message.attachments.size;
  if (size === 0) {
    return [];
  }
  const urls: string[] = [];
  for (const attachment of message.attachments.values()) {
    if (attachment.url) {
      urls.push(attachment.url);
    }
  }
  return urls;
}

function resolveAuthorName(message: Message | PartialMessage): { id: string; name: string } {
  const author = message.author;
  if (author) {
    return { id: author.id, name: author.username };
  }
  return { id: message.author?.id ?? "unknown", name: "unknown" };
}

function collectBulkAuthors(
  messages: ReadonlyCollection<Snowflake, Message | PartialMessage>,
): { id: string; name: string }[] {
  const seen = new Map<string, { id: string; name: string }>();
  for (const message of messages.values()) {
    const author = resolveAuthorName(message);
    if (!seen.has(author.id)) {
      seen.set(author.id, author);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.id.localeCompare(b.id));
}

async function resolveMessage(
  message: Message | PartialMessage,
): Promise<Message | PartialMessage> {
  if (!isPartial(message)) {
    return message;
  }
  try {
    return await message.fetch();
  } catch {
    return message;
  }
}

export function registerMessageAuditHandlers(
  client: Client,
  deps: Omit<MessageAuditDeps, "config"> & { config: MessageAuditConfig },
): void {
  const handler = createMessageAuditHandler(deps);

  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    if (newMessage.author?.bot) {
      return;
    }
    if (!newMessage.guildId) {
      // Skip DMs — the audit channel is guild-scoped by design.
      return;
    }
    const resolvedOld = await resolveMessage(oldMessage);
    const resolvedNew = await resolveMessage(newMessage);

    await handler.onMessageUpdate({
      authorId: resolvedNew.author?.id ?? "unknown",
      authorName: resolvedNew.author?.username ?? resolvedNew.author?.id ?? "unknown",
      channelId: resolvedNew.channelId,
      messageId: resolvedNew.id,
      before: resolvedOld.content ?? null,
      after: resolvedNew.content ?? null,
      editedAt: new Date(resolvedNew.editedTimestamp ?? Date.now()),
      isBot: resolvedNew.author?.bot ?? false,
    });
  });

  client.on(Events.MessageDelete, async (message) => {
    if (message.author?.bot) {
      return;
    }
    if (!message.guildId) {
      return;
    }
    const resolved = await resolveMessage(message);

    await handler.onMessageDelete({
      authorId: resolved.author?.id ?? "unknown",
      authorName: resolved.author?.username ?? resolved.author?.id ?? "unknown",
      channelId: resolved.channelId,
      messageId: resolved.id,
      content: resolved.content ?? null,
      attachmentUrls: resolveAttachmentUrls(resolved),
      deletedAt: new Date(),
      isBot: resolved.author?.bot ?? false,
    });
  });

  client.on(Events.MessageBulkDelete, async (messages, channel) => {
    if (!("guildId" in channel) || !channel.guildId) {
      return;
    }
    const channelName =
      "name" in channel && typeof channel.name === "string" ? channel.name : channel.id;

    await handler.onMessageBulkDelete({
      channelId: channel.id,
      channelName,
      count: messages.size,
      authors: collectBulkAuthors(messages),
      deletedAt: new Date(),
    });
  });
}

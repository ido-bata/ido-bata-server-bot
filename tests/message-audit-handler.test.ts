import { describe, expect, it, vi } from "vitest";

import { createMessageAuditHandler } from "../src/features/message-audit/handler.js";

describe("message audit handler", () => {
  it("posts an edit message when configured and the author is not a bot", async () => {
    const sendMessage = vi.fn<(channelId: string, content: string) => Promise<void>>(
      async () => undefined,
    );
    const handler = createMessageAuditHandler({
      config: { channelId: "audit-channel" },
      sendMessage,
    });

    await handler.onMessageUpdate({
      authorId: "user-1",
      authorName: "alice",
      channelId: "channel-1",
      messageId: "message-1",
      before: "original",
      after: "rewritten",
      editedAt: new Date("2026-09-13T12:00:00Z"),
      isBot: false,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [channelId, content] = sendMessage.mock.calls[0] ?? [];
    expect(channelId).toBe("audit-channel");
    expect(content).toContain("alice");
    expect(content).toContain("edited message message-1");
    expect(content).toContain("original");
    expect(content).toContain("rewritten");
  });

  it("posts a delete message when configured and the author is not a bot", async () => {
    const sendMessage = vi.fn<(channelId: string, content: string) => Promise<void>>(
      async () => undefined,
    );
    const handler = createMessageAuditHandler({
      config: { channelId: "audit-channel" },
      sendMessage,
    });

    await handler.onMessageDelete({
      authorId: "user-2",
      authorName: "bob",
      channelId: "channel-2",
      messageId: "message-2",
      content: "goodbye",
      attachmentUrls: ["https://cdn.example.com/x.png"],
      deletedAt: new Date("2026-09-13T12:00:00Z"),
      isBot: false,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const content = sendMessage.mock.calls[0]?.[1] ?? "";
    expect(content).toContain("bob");
    expect(content).toContain("goodbye");
    expect(content).toContain("https://cdn.example.com/x.png");
  });

  it("posts a bulk-delete summary when configured", async () => {
    const sendMessage = vi.fn<(channelId: string, content: string) => Promise<void>>(
      async () => undefined,
    );
    const handler = createMessageAuditHandler({
      config: { channelId: "audit-channel" },
      sendMessage,
    });

    await handler.onMessageBulkDelete({
      channelId: "channel-3",
      channelName: "general",
      count: 5,
      authors: [
        { id: "user-1", name: "alice" },
        { id: "user-2", name: "bob" },
      ],
      deletedAt: new Date("2026-09-13T12:00:00Z"),
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const content = sendMessage.mock.calls[0]?.[1] ?? "";
    expect(content).toContain("5 messages bulk-deleted");
    expect(content).toContain("alice");
    expect(content).toContain("bob");
  });

  it("ignores edit events for bot-authored messages", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const handler = createMessageAuditHandler({
      config: { channelId: "audit-channel" },
      sendMessage,
    });

    await handler.onMessageUpdate({
      authorId: "bot-1",
      authorName: "automod",
      channelId: "channel-1",
      messageId: "message-1",
      before: "old",
      after: "new",
      editedAt: new Date(),
      isBot: true,
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("ignores delete events for bot-authored messages", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const handler = createMessageAuditHandler({
      config: { channelId: "audit-channel" },
      sendMessage,
    });

    await handler.onMessageDelete({
      authorId: "bot-1",
      authorName: "automod",
      channelId: "channel-1",
      messageId: "message-1",
      content: null,
      attachmentUrls: [],
      deletedAt: new Date(),
      isBot: true,
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("is a no-op when no audit channel is configured", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const handler = createMessageAuditHandler({
      config: { channelId: "" },
      sendMessage,
    });

    expect(handler.isConfigured()).toBe(false);

    await handler.onMessageUpdate({
      authorId: "user-1",
      authorName: "alice",
      channelId: "channel-1",
      messageId: "message-1",
      before: "before",
      after: "after",
      editedAt: new Date(),
      isBot: false,
    });
    await handler.onMessageDelete({
      authorId: "user-1",
      authorName: "alice",
      channelId: "channel-1",
      messageId: "message-1",
      content: "text",
      attachmentUrls: [],
      deletedAt: new Date(),
      isBot: false,
    });
    await handler.onMessageBulkDelete({
      channelId: "channel-1",
      channelName: "general",
      count: 3,
      authors: [{ id: "user-1", name: "alice" }],
      deletedAt: new Date(),
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not throw when no sender is provided", async () => {
    const handler = createMessageAuditHandler({
      config: { channelId: "audit-channel" },
    });

    await expect(
      handler.onMessageUpdate({
        authorId: "user-1",
        authorName: "alice",
        channelId: "channel-1",
        messageId: "message-1",
        before: "before",
        after: "after",
        editedAt: new Date(),
        isBot: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("logs and swallows post failures so the bot keeps running", async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error("channel missing");
    });
    const log = vi.fn();
    const handler = createMessageAuditHandler({
      config: { channelId: "audit-channel" },
      sendMessage,
      log,
    });

    await expect(
      handler.onMessageUpdate({
        authorId: "user-1",
        authorName: "alice",
        channelId: "channel-1",
        messageId: "message-1",
        before: "before",
        after: "after",
        editedAt: new Date(),
        isBot: false,
      }),
    ).resolves.toBeUndefined();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("channel missing");
  });
});

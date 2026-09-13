import { describe, expect, it } from "vitest";

import {
  formatBulkDeleteAudit,
  formatDeleteAudit,
  formatEditAudit,
} from "../src/features/message-audit/template.js";

describe("message audit template", () => {
  it("renders before/after blocks for an edit when content is available", () => {
    const editedAt = new Date("2026-09-13T12:30:00Z");
    const editedSeconds = Math.floor(editedAt.getTime() / 1000).toString();

    const message = formatEditAudit({
      authorId: "user-1",
      authorName: "alice",
      channelId: "channel-1",
      messageId: "message-1",
      before: "original",
      after: "rewritten",
      editedAt,
    });

    expect(message).toBe(
      `<t:${editedSeconds}:F> ✏️ alice (user-1) edited message message-1 in <#channel-1>\n**Before**\noriginal\n**After**\nrewritten`,
    );
  });

  it("replaces content with a placeholder when MessageContent intent is off", () => {
    const editedAt = new Date("2026-09-13T12:30:00Z");
    const editedSeconds = Math.floor(editedAt.getTime() / 1000).toString();

    const message = formatEditAudit({
      authorId: "user-1",
      authorName: "alice",
      channelId: "channel-1",
      messageId: "message-1",
      before: null,
      after: null,
      editedAt,
    });

    expect(message).toContain("Before");
    expect(message).toContain("After");
    expect(message).toContain("(text unavailable — MessageContent intent is not enabled)");
    expect(message.startsWith(`<t:${editedSeconds}:F>`)).toBe(true);
  });

  it("renders the delete message with content and attachments", () => {
    const deletedAt = new Date("2026-09-13T13:45:00Z");
    const deletedSeconds = Math.floor(deletedAt.getTime() / 1000).toString();

    const message = formatDeleteAudit({
      authorId: "user-2",
      authorName: "bob",
      channelId: "channel-2",
      messageId: "message-2",
      content: "i regret nothing",
      attachmentUrls: ["https://cdn.example.com/a.png", "https://cdn.example.com/b.png"],
      deletedAt,
    });

    expect(message).toBe(
      `<t:${deletedSeconds}:F> 🗑️ bob (user-2) — message message-2 deleted in <#channel-2>\nContent\ni regret nothing\nAttachments\n- https://cdn.example.com/a.png\n- https://cdn.example.com/b.png`,
    );
  });

  it("renders the delete message without attachments when none exist", () => {
    const deletedAt = new Date("2026-09-13T13:45:00Z");

    const message = formatDeleteAudit({
      authorId: "user-2",
      authorName: "bob",
      channelId: "channel-2",
      messageId: "message-2",
      content: null,
      attachmentUrls: [],
      deletedAt,
    });

    expect(message).not.toContain("Attachments");
    expect(message).toContain("Content");
  });

  it("renders the bulk-delete summary with the author roster", () => {
    const deletedAt = new Date("2026-09-13T14:00:00Z");
    const deletedSeconds = Math.floor(deletedAt.getTime() / 1000).toString();

    const message = formatBulkDeleteAudit({
      channelId: "channel-3",
      channelName: "general",
      count: 3,
      authors: [
        { id: "user-2", name: "bob" },
        { id: "user-1", name: "alice" },
      ],
      deletedAt,
    });

    expect(message).toBe(
      `<t:${deletedSeconds}:F> 🧹 3 messages bulk-deleted in #general (<#channel-3>)\nAuthors\n- bob (user-2)\n- alice (user-1)`,
    );
  });

  it("uses a singular noun when only one message is bulk-deleted", () => {
    const deletedAt = new Date("2026-09-13T14:00:00Z");

    const message = formatBulkDeleteAudit({
      channelId: "channel-3",
      channelName: "general",
      count: 1,
      authors: [],
      deletedAt,
    });

    expect(message).toContain("1 message bulk-deleted");
    expect(message).toContain("_(no resolvable authors — partial payloads)_");
  });
});

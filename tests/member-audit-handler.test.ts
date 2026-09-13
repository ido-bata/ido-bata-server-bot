import { describe, expect, it, vi } from "vitest";

import { createMemberAuditHandler } from "../src/features/member-audit/handler.js";

describe("member audit handler", () => {
  it("posts a join message when configured and the member is not a bot", async () => {
    const sendMessage = vi.fn<(channelId: string, content: string) => Promise<void>>(
      async () => undefined,
    );
    const handler = createMemberAuditHandler({
      config: { channelId: "audit-channel" },
      sendMessage,
    });

    await handler.onMemberJoin({
      memberId: "user-1",
      memberName: "alice",
      isBot: false,
      joinedAt: new Date("2026-09-13T12:00:00Z"),
      accountCreatedAt: new Date("2026-08-01T00:00:00Z"),
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = sendMessage.mock.calls[0];
    expect(call?.[0]).toBe("audit-channel");
    expect(call?.[1]).toContain("alice joined");
  });

  it("posts a leave message when configured and the member is not a bot", async () => {
    const sendMessage = vi.fn<(channelId: string, content: string) => Promise<void>>(
      async () => undefined,
    );
    const handler = createMemberAuditHandler({
      config: { channelId: "audit-channel" },
      sendMessage,
    });

    await handler.onMemberLeave({
      memberId: "user-2",
      memberName: "bob",
      isBot: false,
      leftAt: new Date("2026-09-13T13:30:00Z"),
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const content = sendMessage.mock.calls[0]?.[1] ?? "";
    expect(content).toContain("bob left");
  });

  it("ignores join events for bot accounts", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const handler = createMemberAuditHandler({
      config: { channelId: "audit-channel" },
      sendMessage,
    });

    await handler.onMemberJoin({
      memberId: "bot-1",
      memberName: "automod",
      isBot: true,
      joinedAt: new Date(),
      accountCreatedAt: new Date(),
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("ignores leave events for bot accounts", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const handler = createMemberAuditHandler({
      config: { channelId: "audit-channel" },
      sendMessage,
    });

    await handler.onMemberLeave({
      memberId: "bot-1",
      memberName: "automod",
      isBot: true,
      leftAt: new Date(),
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("is a no-op when no audit channel is configured", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const handler = createMemberAuditHandler({
      config: { channelId: "" },
      sendMessage,
    });

    expect(handler.isConfigured()).toBe(false);

    await handler.onMemberJoin({
      memberId: "user-1",
      memberName: "alice",
      isBot: false,
      joinedAt: new Date(),
      accountCreatedAt: new Date(),
    });
    await handler.onMemberLeave({
      memberId: "user-1",
      memberName: "alice",
      isBot: false,
      leftAt: new Date(),
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not throw when no sender is provided", async () => {
    const handler = createMemberAuditHandler({
      config: { channelId: "audit-channel" },
    });

    await expect(
      handler.onMemberJoin({
        memberId: "user-1",
        memberName: "alice",
        isBot: false,
        joinedAt: new Date(),
        accountCreatedAt: null,
      }),
    ).resolves.toBeUndefined();
  });

  it("logs and swallows post failures so the bot keeps running", async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error("channel missing");
    });
    const log = vi.fn();
    const handler = createMemberAuditHandler({
      config: { channelId: "audit-channel" },
      sendMessage,
      log,
    });

    await expect(
      handler.onMemberJoin({
        memberId: "user-1",
        memberName: "alice",
        isBot: false,
        joinedAt: new Date(),
        accountCreatedAt: null,
      }),
    ).resolves.toBeUndefined();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("channel missing");
  });
});

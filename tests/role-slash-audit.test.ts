import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import {
  createChannelAuditLogger,
  createConsoleAuditLogger,
  formatAuditEntry,
} from "../src/features/role-slash/audit.js";

function firstCall(mock: Mock<(message: string) => void>): string | undefined {
  if (mock.mock.calls.length === 0) {
    return undefined;
  }
  return mock.mock.calls[0]?.[0];
}

describe("role-slash audit", () => {
  it("formats an entry with action/guild/user/role/result", () => {
    const formatted = formatAuditEntry({
      action: "assign",
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      result: "success",
    });
    expect(formatted).toContain("action=assign");
    expect(formatted).toContain("guild=guild-1");
    expect(formatted).toContain("user=user-1");
    expect(formatted).toContain("role=role-1");
    expect(formatted).toContain("result=success");
  });

  it("appends reason when provided", () => {
    const formatted = formatAuditEntry({
      action: "remove",
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      result: "error",
      reason: "not_assignable",
    });
    expect(formatted).toContain("reason=not_assignable");
  });

  it("writes to the provided console logger", () => {
    const log = vi.fn<(message: string) => void>();
    const audit = createConsoleAuditLogger({ log });
    audit({
      action: "assign",
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      result: "success",
    });
    expect(log).toHaveBeenCalledTimes(1);
    const firstMessage = firstCall(log);
    expect(firstMessage).toContain("role-slash");
  });

  it("falls back to console logger when channel id is null", () => {
    const log = vi.fn<(message: string) => void>();
    const factory = createChannelAuditLogger({ fetchChannel: vi.fn() });
    const audit = factory(null);
    expect(typeof audit).toBe("function");
    const fallback = createConsoleAuditLogger({ log });
    fallback({
      action: "remove",
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      result: "success",
    });
    expect(log).toHaveBeenCalled();
  });

  it("posts to the channel when configured and channel is text-based", async () => {
    const send = vi.fn<(message: string) => Promise<void>>(
      async () => undefined,
    );
    const channel = { isTextBased: () => true, send };
    const fetchChannel = vi.fn<(id: string) => Promise<typeof channel>>(
      async () => channel,
    );
    const factory = createChannelAuditLogger({ fetchChannel });
    const audit = factory("channel-1");

    await audit({
      action: "assign",
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      result: "success",
    });

    expect(fetchChannel).toHaveBeenCalledWith("channel-1");
    expect(send).toHaveBeenCalledTimes(1);
    const firstMessage = send.mock.calls[0]?.[0];
    expect(firstMessage).toContain("action=assign");
  });

  it("warns and does not throw when channel fetch fails", async () => {
    const warn = vi.fn<(message: string) => void>();
    const fetchChannel = vi.fn<(id: string) => Promise<unknown>>(async () => {
      throw new Error("network down");
    });
    const factory = createChannelAuditLogger({ fetchChannel, logger: { warn } });
    const audit = factory("channel-1");

    await expect(
      audit({
        action: "remove",
        guildId: "guild-1",
        userId: "user-1",
        roleId: "role-1",
        result: "error",
        reason: "internal_error",
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
  });

  it("silently no-ops when channel is not text based", async () => {
    const send = vi.fn<(message: string) => Promise<void>>();
    const channel = { isTextBased: () => false, send };
    const fetchChannel = vi.fn<(id: string) => Promise<typeof channel>>(
      async () => channel,
    );
    const factory = createChannelAuditLogger({ fetchChannel });
    const audit = factory("channel-1");

    await audit({
      action: "assign",
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      result: "success",
    });

    expect(send).not.toHaveBeenCalled();
  });
});
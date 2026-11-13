import { ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { AnonAuditSink } from "../src/features/anonymous-chat/audit-store.js";
import type { AnonymousChatConfig } from "../src/features/anonymous-chat/config.js";
import type {
  AnonBits,
  AnonChannelLike,
  AnonGuildLike,
  AnonMemberLike,
} from "../src/features/anonymous-chat/permissions.js";
import type { AnonLogger } from "../src/features/anonymous-chat/service.js";
import { createAnonymousChatService } from "../src/features/anonymous-chat/service.js";

const VIEW = PermissionFlagsBits.ViewChannel;
const SEND = PermissionFlagsBits.SendMessages;
const SEND_THREAD = PermissionFlagsBits.SendMessagesInThreads;
const ADMIN = PermissionFlagsBits.Administrator;

function bitsOf(...flags: bigint[]): AnonBits {
  return new PermissionsBitField(
    flags.reduce((acc, flag) => acc | flag, 0n),
  ) as unknown as AnonBits;
}

function member(id: string, admin = false): AnonMemberLike {
  const permBits = bitsOf(...(admin ? [ADMIN] : []));
  return {
    id,
    permissions: { has: (bit) => permBits.has(bit) },
    roles: { cache: { has: () => false } },
  };
}

const GUILD: AnonGuildLike = { id: "guild-1", ownerId: "owner-1" };

type ChannelSpec = {
  id?: string;
  guildId?: string | null;
  type?: number;
  permsByMemberId?: Record<string, AnonBits | null>;
  locked?: boolean;
  sendImpl?: () => Promise<{ id: string; delete: () => Promise<unknown> }>;
};

function makeChannel(spec: ChannelSpec = {}) {
  const send = vi.fn(
    spec.sendImpl ?? (async () => ({ id: "msg-1", delete: async () => undefined })),
  );
  const permsByMemberId = spec.permsByMemberId ?? {};
  const channel: AnonChannelLike = {
    id: spec.id ?? "chan-1",
    guildId: spec.guildId === undefined ? "guild-1" : spec.guildId,
    type: spec.type ?? ChannelType.GuildText,
    parent: null,
    parentId: null,
    locked: spec.locked ?? false,
    archived: false,
    isTextBased: () => true,
    permissionsFor: (subject) => permsByMemberId[subject.id] ?? null,
    send: send as AnonChannelLike["send"],
  };
  return { channel, send };
}

function makeConfig(overrides: Partial<AnonymousChatConfig> = {}): AnonymousChatConfig {
  return {
    denyChannelIds: new Set<string>(),
    cooldownMs: 30_000,
    maxMessageLength: 1000,
    audit: null,
    ...overrides,
  };
}

function makeDeps(
  overrides: {
    channel?: AnonChannelLike | null;
    config?: AnonymousChatConfig;
    member?: AnonMemberLike | null;
    botMember?: AnonMemberLike | null;
    guild?: AnonGuildLike | null;
    threadMember?: boolean;
    authorizeAudit?: (userId: string) => Promise<boolean>;
    audit?: AnonAuditSink | null;
    now?: () => number;
  } = {},
) {
  const channel = overrides.channel === undefined ? makeChannel().channel : overrides.channel;
  const memberObj = overrides.member === undefined ? member("user-1") : overrides.member;
  const botMemberObj = overrides.botMember === undefined ? member("bot-1") : overrides.botMember;
  const guildObj = overrides.guild === undefined ? GUILD : overrides.guild;

  const warn = vi.fn();
  const error = vi.fn();
  const logger: AnonLogger = { warn, error };
  const service = createAnonymousChatService({
    config: overrides.config ?? makeConfig(),
    fetchChannel: async () => channel,
    fetchGuild: async () => guildObj,
    fetchMember: async () => memberObj,
    fetchBotMember: async () => botMemberObj,
    isThreadMember: async () => overrides.threadMember ?? true,
    authorizeAudit: overrides.authorizeAudit,
    audit: overrides.audit,
    now: overrides.now,
    logger,
  });
  return { service, logger: { warn, error }, channel };
}

const INPUT = { userId: "user-1", guildId: "guild-1", channelId: "chan-1", message: "hello" };

describe("anonymous-chat service — happy path", () => {
  it("posts with mentions disabled and returns ok", async () => {
    const { channel, send } = makeChannel({
      permsByMemberId: {
        "user-1": bitsOf(VIEW, SEND),
        "bot-1": bitsOf(VIEW, SEND),
      },
    });
    const { service } = makeDeps({ channel });
    const result = await service.post(INPUT);
    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith({
      content: "hello",
      allowedMentions: { parse: [] },
    });
  });

  it("trims the message before posting", async () => {
    const { channel, send } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
    });
    const { service } = makeDeps({ channel });
    await service.post({ ...INPUT, message: "  padded  " });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ content: "padded" }));
  });
});

describe("anonymous-chat service — input validation", () => {
  it("rejects empty and over-length messages without touching Discord", async () => {
    const { channel, send } = makeChannel();
    const { service } = makeDeps({ channel });
    expect(await service.post({ ...INPUT, message: "   " })).toEqual({
      ok: false,
      reason: "invalid_message",
    });
    expect(await service.post({ ...INPUT, message: "x".repeat(1001) })).toEqual({
      ok: false,
      reason: "invalid_message",
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("anonymous-chat service — deny-list & cooldown", () => {
  it("denies channels on the deny-list", async () => {
    const { channel, send } = makeChannel();
    const { service } = makeDeps({
      channel,
      config: makeConfig({ denyChannelIds: new Set(["chan-1"]) }),
    });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
    expect(send).not.toHaveBeenCalled();
  });

  it("enforces the per-user cooldown across attempts", async () => {
    let now = 0;
    const { channel, send } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
    });
    const { service } = makeDeps({ channel, now: () => now });
    expect((await service.post(INPUT)).ok).toBe(true);
    const second = await service.post(INPUT);
    expect(second).toMatchObject({ ok: false, reason: "cooldown" });
    expect(send).toHaveBeenCalledTimes(1);
    now += 31_000;
    expect((await service.post(INPUT)).ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("anonymous-chat service — channel & guild resolution (fail closed)", () => {
  it("denies when the channel cannot be fetched", async () => {
    const { service } = makeDeps({ channel: null });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
  });

  it("denies when the channel belongs to a different guild", async () => {
    const { channel } = makeChannel({ guildId: "other-guild" });
    const { service } = makeDeps({ channel });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
  });

  it("denies DM-style channels (null guildId)", async () => {
    const { channel } = makeChannel({ guildId: null });
    const { service } = makeDeps({ channel });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
  });

  it("denies non-text channels without a send capability", async () => {
    const { channel } = makeChannel();
    channel.isTextBased = () => false;
    const { service } = makeDeps({ channel });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
  });

  it("denies when the guild or member cannot be resolved", async () => {
    const { channel } = makeChannel();
    expect(await makeDeps({ channel, guild: null }).service.post(INPUT)).toEqual({
      ok: false,
      reason: "denied",
    });
    expect(await makeDeps({ channel, member: null }).service.post(INPUT)).toEqual({
      ok: false,
      reason: "denied",
    });
  });
});

describe("anonymous-chat service — permission checks", () => {
  it("denies when the user lacks SendMessages", async () => {
    const { channel, send } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW), "bot-1": bitsOf(VIEW, SEND) },
    });
    const { service } = makeDeps({ channel });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
    expect(send).not.toHaveBeenCalled();
  });

  it("denies when the user lacks ViewChannel", async () => {
    const { channel } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(SEND), "bot-1": bitsOf(VIEW, SEND) },
    });
    const { service } = makeDeps({ channel });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
  });

  it("denies when permissionsFor returns null (unresolvable)", async () => {
    const { channel } = makeChannel({ permsByMemberId: {} });
    const { service } = makeDeps({ channel });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
  });

  it("reports bot_permission_denied when the bot cannot send", async () => {
    const { channel, send } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW) },
    });
    const { service } = makeDeps({ channel });
    expect(await service.post(INPUT)).toEqual({
      ok: false,
      reason: "bot_permission_denied",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("allows an admin user even when channel bits look restrictive", async () => {
    const { channel, send } = makeChannel({
      permsByMemberId: { "user-1": null, "bot-1": bitsOf(VIEW, SEND) },
    });
    const { service } = makeDeps({ channel, member: member("user-1", true) });
    expect((await service.post(INPUT)).ok).toBe(true);
    expect(send).toHaveBeenCalled();
  });
});

describe("anonymous-chat service — threads", () => {
  function makeThread(overrides: { locked?: boolean; parentBits?: AnonBits | null } = {}) {
    const { channel: parent } = makeChannel({
      permsByMemberId: {
        "user-1": overrides.parentBits ?? bitsOf(VIEW, SEND_THREAD),
        "bot-1": bitsOf(VIEW, SEND_THREAD),
      },
    });
    const { channel, send } = makeChannel({
      type: ChannelType.PublicThread,
      permsByMemberId: {},
    });
    channel.parent = parent;
    channel.parentId = "chan-1";
    channel.locked = overrides.locked ?? false;
    return { channel, send };
  }

  it("posts in a public thread when parent perms allow", async () => {
    const { channel, send } = makeThread();
    const { service } = makeDeps({ channel });
    expect((await service.post(INPUT)).ok).toBe(true);
    expect(send).toHaveBeenCalled();
  });

  it("denies locked threads", async () => {
    const { channel, send } = makeThread({ locked: true });
    const { service } = makeDeps({ channel });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
    expect(send).not.toHaveBeenCalled();
  });

  it("denies private threads for non-members", async () => {
    const { channel: parent } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND_THREAD), "bot-1": bitsOf(VIEW, SEND_THREAD) },
    });
    const { channel, send } = makeChannel({
      type: ChannelType.PrivateThread,
      permsByMemberId: {},
    });
    channel.parent = parent;
    channel.parentId = "chan-1";
    const { service } = makeDeps({ channel, threadMember: false });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
    expect(send).not.toHaveBeenCalled();
  });

  it("allows private threads for members", async () => {
    const { channel: parent } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND_THREAD), "bot-1": bitsOf(VIEW, SEND_THREAD) },
    });
    const { channel, send } = makeChannel({
      type: ChannelType.PrivateThread,
      permsByMemberId: {},
    });
    channel.parent = parent;
    channel.parentId = "chan-1";
    const { service } = makeDeps({ channel, threadMember: true });
    expect((await service.post(INPUT)).ok).toBe(true);
    expect(send).toHaveBeenCalled();
  });
});

describe("anonymous-chat service — Discord API failures", () => {
  it("returns post_failed when channel.send rejects", async () => {
    const { channel } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
      sendImpl: async () => {
        throw new Error("DiscordAPIError: Missing Permissions");
      },
    });
    const { service, logger } = makeDeps({ channel });
    const result = await service.post(INPUT);
    expect(result).toEqual({ ok: false, reason: "post_failed" });
    expect(logger.warn).toHaveBeenCalled();
    // The log must not contain the raw user id as a structured field.
    const logged = logger.warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(logged).not.toHaveProperty("userId");
    expect(logged).not.toHaveProperty("user");
  });
});

describe("anonymous-chat service — audit mode", () => {
  function makeAudit(overrides: Partial<AnonAuditSink> = {}): AnonAuditSink {
    return {
      seal: vi.fn(() => "sealed-ct"),
      record: vi.fn(async () => undefined),
      sweep: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  function auditConfig(): AnonymousChatConfig {
    return makeConfig({
      audit: {
        publicKey: "unused-injected-sink",
        indexKey: "idx",
        dir: "data/anon-audit",
        retentionDays: 90,
      },
    });
  }

  it("seals before posting and records after a successful send", async () => {
    const { channel, send } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
    });
    const audit = makeAudit();
    const { service } = makeDeps({ channel, config: auditConfig(), audit });
    const result = await service.post(INPUT);
    expect(result).toEqual({ ok: true });
    expect(audit.seal).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", guildId: "guild-1", channelId: "chan-1" }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        messageId: "msg-1",
        ciphertext: "sealed-ct",
      }),
    );
    expect(send).toHaveBeenCalled();
  });

  it("rejects the post when sealing fails — send is never called", async () => {
    const { channel, send } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
    });
    const audit = makeAudit({
      seal: vi.fn(() => {
        throw new Error("bad key");
      }),
    });
    const { service } = makeDeps({ channel, config: auditConfig(), audit });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "unavailable" });
    expect(send).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("deletes the posted message when the audit append fails", async () => {
    const deleteMock = vi.fn(async () => undefined);
    const { channel } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
      sendImpl: async () => ({ id: "msg-9", delete: deleteMock }),
    });
    const audit = makeAudit({
      record: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const { service } = makeDeps({ channel, config: auditConfig(), audit });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "audit_failed" });
    expect(deleteMock).toHaveBeenCalled();
  });

  it("denies audit writes when consent authorization fails", async () => {
    const { channel, send } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
    });
    const audit = makeAudit();
    const { service } = makeDeps({
      channel,
      config: auditConfig(),
      audit,
      authorizeAudit: async () => false,
    });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "unavailable" });
    expect(send).not.toHaveBeenCalled();
    expect(audit.seal).not.toHaveBeenCalled();
  });

  it("treats a throwing consent check as deny", async () => {
    const { channel, send } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
    });
    const audit = makeAudit();
    const { service } = makeDeps({
      channel,
      config: auditConfig(),
      audit,
      authorizeAudit: async () => {
        throw new Error("consent store down");
      },
    });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "unavailable" });
    expect(send).not.toHaveBeenCalled();
  });
});

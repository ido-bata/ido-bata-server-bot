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
const MANAGE_THREADS = PermissionFlagsBits.ManageThreads;
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
  locked?: boolean | null;
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
    locked: spec.locked === undefined ? false : spec.locked,
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

function makePassThroughAudit(): AnonAuditSink {
  return {
    seal: vi.fn(() => "ct"),
    record: vi.fn(async () => undefined),
    sweep: vi.fn(async () => undefined),
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
    isThreadMember?: (channel: AnonChannelLike, userId: string) => Promise<boolean>;
    fetchChannel?: (channelId: string) => Promise<AnonChannelLike | null>;
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
    fetchChannel: overrides.fetchChannel ?? (async () => channel),
    fetchGuild: async () => guildObj,
    fetchMember: async () => memberObj,
    fetchBotMember: async () => botMemberObj,
    isThreadMember: overrides.isThreadMember ?? (async () => overrides.threadMember ?? true),
    authorizeAudit: overrides.authorizeAudit,
    // Audit is mandatory (Issue #118): deps without an explicit audit
    // get a pass-through sink so permission/validation tests exercise
    // the post path — UNLESS config.audit is set, in which case the
    // service builds the real sink (broken-key tests rely on that).
    // `audit: null` still yields "disabled".
    audit:
      overrides.audit === undefined && overrides.config?.audit == null
        ? makePassThroughAudit()
        : overrides.audit,
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

  it("consumes the cooldown even for deny-listed attempts", async () => {
    // A denied attempt still burns the cooldown slot so permission
    // probing cannot be repeated without waiting (ADR-0003 §2).
    const { channel } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
    });
    const { service } = makeDeps({
      channel,
      config: makeConfig({ denyChannelIds: new Set(["chan-1"]) }),
    });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
    // Same user, different (allowed) channel → cooldown, not success.
    expect(await service.post({ ...INPUT, channelId: "chan-2" })).toMatchObject({
      ok: false,
      reason: "cooldown",
    });
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
  function makeThread(
    overrides: { locked?: boolean | null; parentBits?: AnonBits | null; type?: number } = {},
  ) {
    const { channel: parent } = makeChannel({
      id: "parent-1",
      permsByMemberId: {
        "user-1": overrides.parentBits ?? bitsOf(VIEW, SEND_THREAD),
        "bot-1": bitsOf(VIEW, SEND_THREAD),
      },
    });
    const { channel, send } = makeChannel({
      type: overrides.type ?? ChannelType.PublicThread,
      permsByMemberId: {},
    });
    channel.parent = parent;
    channel.parentId = "parent-1";
    channel.locked = overrides.locked === undefined ? false : overrides.locked;
    // Thread permission resolution always re-fetches the parent.
    const fetchChannel = async (id: string) =>
      id === "parent-1" ? parent : id === channel.id ? channel : null;
    return { channel, send, parent, fetchChannel };
  }

  it("posts in a public thread when parent perms allow", async () => {
    const { channel, send, fetchChannel } = makeThread();
    const { service } = makeDeps({ channel, fetchChannel });
    expect((await service.post(INPUT)).ok).toBe(true);
    expect(send).toHaveBeenCalled();
  });

  it("denies locked threads", async () => {
    const { channel, send, fetchChannel } = makeThread({ locked: true });
    const { service } = makeDeps({ channel, fetchChannel });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
    expect(send).not.toHaveBeenCalled();
  });

  it("denies threads whose locked state is unknown (null) — fail closed", async () => {
    const { channel, send, fetchChannel } = makeThread({ locked: null });
    const { service } = makeDeps({ channel, fetchChannel });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
    expect(send).not.toHaveBeenCalled();
  });

  it("denies when the fresh parent fetch fails or returns nothing — fail closed", async () => {
    const { channel, send, fetchChannel } = makeThread();
    const { service } = makeDeps({
      channel,
      fetchChannel: async (id) => (id === "parent-1" ? null : fetchChannel(id)),
    });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
    expect(send).not.toHaveBeenCalled();
  });

  it("denies when the freshly fetched parent revoked the overwrite the cached parent still allows", async () => {
    // Regression: `channel.parent` is cached and permissive, but the
    // fresh fetch returns the post-revocation parent — the decision
    // must use the fresh bits.
    const { channel, send } = makeThread();
    const revokedParent = makeChannel({
      id: "parent-1",
      permsByMemberId: { "user-1": bitsOf(VIEW), "bot-1": bitsOf(VIEW, SEND_THREAD) },
    }).channel;
    const { service } = makeDeps({
      channel,
      fetchChannel: async (id) =>
        id === "parent-1" ? revokedParent : id === channel.id ? channel : null,
    });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
    expect(send).not.toHaveBeenCalled();
  });

  it("denies private threads for non-members", async () => {
    const { channel: parent } = makeChannel({
      id: "parent-1",
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND_THREAD), "bot-1": bitsOf(VIEW, SEND_THREAD) },
    });
    const { channel, send } = makeChannel({
      type: ChannelType.PrivateThread,
      permsByMemberId: {},
    });
    channel.parent = parent;
    channel.parentId = "parent-1";
    const { service } = makeDeps({
      channel,
      threadMember: false,
      fetchChannel: async (id) => (id === "parent-1" ? parent : id === channel.id ? channel : null),
    });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
    expect(send).not.toHaveBeenCalled();
  });

  it("allows private threads for members", async () => {
    const { channel: parent } = makeChannel({
      id: "parent-1",
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND_THREAD), "bot-1": bitsOf(VIEW, SEND_THREAD) },
    });
    const { channel, send } = makeChannel({
      type: ChannelType.PrivateThread,
      permsByMemberId: {},
    });
    channel.parent = parent;
    channel.parentId = "parent-1";
    const { service } = makeDeps({
      channel,
      threadMember: true,
      fetchChannel: async (id) => (id === "parent-1" ? parent : id === channel.id ? channel : null),
    });
    expect((await service.post(INPUT)).ok).toBe(true);
    expect(send).toHaveBeenCalled();
  });

  it("denies private threads when the bot is neither a member nor a moderator", async () => {
    const { channel: parent } = makeChannel({
      id: "parent-1",
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND_THREAD), "bot-1": bitsOf(VIEW, SEND_THREAD) },
    });
    const { channel, send } = makeChannel({
      type: ChannelType.PrivateThread,
      permsByMemberId: {},
    });
    channel.parent = parent;
    channel.parentId = "parent-1";
    const { service } = makeDeps({
      channel,
      isThreadMember: async (_c, userId) => userId === "user-1",
      fetchChannel: async (id) => (id === "parent-1" ? parent : id === channel.id ? channel : null),
    });
    expect(await service.post(INPUT)).toEqual({
      ok: false,
      reason: "bot_permission_denied",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("allows private threads when the bot holds ManageThreads without membership", async () => {
    const { channel: parent } = makeChannel({
      id: "parent-1",
      permsByMemberId: {
        "user-1": bitsOf(VIEW, SEND_THREAD),
        "bot-1": bitsOf(VIEW, SEND_THREAD, MANAGE_THREADS),
      },
    });
    const { channel, send } = makeChannel({
      type: ChannelType.PrivateThread,
      permsByMemberId: {},
    });
    channel.parent = parent;
    channel.parentId = "parent-1";
    const { service } = makeDeps({
      channel,
      isThreadMember: async (_c, userId) => userId === "user-1",
      fetchChannel: async (id) => (id === "parent-1" ? parent : id === channel.id ? channel : null),
    });
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
        keyId: "v1",
        dir: "data/anon-audit",
        retentionDays: 90,
      },
    });
  }

  it("writes attempt record BEFORE send and posted record with messageId AFTER", async () => {
    const { channel, send } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
    });
    const audit = makeAudit();
    const { service } = makeDeps({ channel, config: auditConfig(), audit });
    const result = await service.post(INPUT);
    expect(result).toEqual({ ok: true });

    // Two seal calls: attempt (pre-send, no messageId) then posted
    // (post-send, carries the real messageId from channel.send).
    const sealCalls = (audit.seal as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(sealCalls).toHaveLength(2);
    expect(sealCalls[0]).toMatchObject({
      v: 2,
      kind: "attempt",
      userId: "user-1",
      guildId: "guild-1",
      channelId: "chan-1",
    });
    expect(sealCalls[0]).not.toHaveProperty("messageId");
    expect(sealCalls[1]).toMatchObject({
      v: 2,
      kind: "posted",
      userId: "user-1",
      messageId: "msg-1",
    });
    // Both phases share the same random attemptId for correlation.
    expect(sealCalls[1]?.attemptId).toBe(sealCalls[0]?.attemptId);
    expect(typeof sealCalls[0]?.attemptId).toBe("string");

    const recordCalls = (audit.record as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(recordCalls).toHaveLength(2);
    expect(recordCalls[0]).toMatchObject({ kind: "attempt", ciphertext: "sealed-ct" });
    expect(recordCalls[1]).toMatchObject({ kind: "posted", ciphertext: "sealed-ct" });
    expect(send).toHaveBeenCalled();

    // Ordering: attempt record < send < posted record.
    const orders = (audit.record as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    const sendOrder = send.mock.invocationCallOrder[0]!;
    expect(orders[0]!).toBeLessThan(sendOrder);
    expect(orders[1]!).toBeGreaterThan(sendOrder);
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
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "audit_failed" });
    expect(send).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("rejects the post when the audit append fails — send is never called", async () => {
    const { channel, send } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
    });
    const audit = makeAudit({
      record: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const { service } = makeDeps({ channel, config: auditConfig(), audit });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "audit_failed" });
    expect(send).not.toHaveBeenCalled();
  });

  it("leaves an orphan audit record when the send fails after append", async () => {
    const { channel, send } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
      sendImpl: async () => {
        throw new Error("DiscordAPIError: 50013");
      },
    });
    const audit = makeAudit();
    const { service } = makeDeps({ channel, config: auditConfig(), audit });
    // Over-recording is the safe direction: the record exists even
    // though no message was posted (ADR-0003 §3).
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "post_failed" });
    // Only the attempt record exists — the send failed before the
    // posted phase. Over-recording is the safe direction.
    const recordCalls = (audit.record as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0]).toMatchObject({ kind: "attempt" });
    expect(send).toHaveBeenCalled();
  });

  it("deletes the message and fails closed when the posted record cannot be written", async () => {
    const del = vi.fn(async () => undefined);
    const { channel, send } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
      sendImpl: async () => ({ id: "msg-42", delete: del }),
    });
    // Attempt record succeeds; the posted record fails.
    const audit = makeAudit({
      record: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("disk full")),
    });
    const { service } = makeDeps({ channel, config: auditConfig(), audit });

    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "audit_failed" });
    expect(send).toHaveBeenCalledTimes(1);
    // The live message is removed best-effort so no anonymous post
    // lacks exact messageId correlation (ADR-0003 §3).
    expect(del).toHaveBeenCalledTimes(1);
    // The feature degrades to error: subsequent posts refuse too.
    expect(service.auditState).toBe("error");
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "unavailable" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("still fails closed when the posted-record delete also fails", async () => {
    const del = vi.fn(async () => {
      throw new Error("delete failed");
    });
    const { channel } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
      sendImpl: async () => ({ id: "msg-43", delete: del }),
    });
    const audit = makeAudit({
      record: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("disk full")),
    });
    const { service } = makeDeps({ channel, config: auditConfig(), audit });

    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "audit_failed" });
    expect(del).toHaveBeenCalledTimes(1);
    expect(service.auditState).toBe("error");
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("flips auditState to error before awaiting the best-effort delete", async () => {
    let resolveDelete: (() => void) | undefined;
    const del = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const { channel } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
      sendImpl: async () => ({ id: "msg-44", delete: del }),
    });
    const audit = makeAudit({
      record: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("disk full")),
    });
    const { service } = makeDeps({ channel, config: auditConfig(), audit });

    const pending = service.post(INPUT);
    await vi.waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    // The Discord delete is still unresolved, but the gate must
    // already be closed — a slow delete cannot leave a window where
    // new posts pass the active check.
    expect(service.auditState).toBe("error");
    expect(await service.post({ ...INPUT, userId: "user-2" })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    resolveDelete?.();
    await expect(pending).resolves.toEqual({ ok: false, reason: "audit_failed" });
  });

  it("aborts an in-flight post at the send boundary once auditState flips", async () => {
    const { channel, send } = makeChannel({
      permsByMemberId: {
        "user-1": bitsOf(VIEW, SEND),
        "user-2": bitsOf(VIEW, SEND),
        "bot-1": bitsOf(VIEW, SEND),
      },
    });
    // Two concurrent posts. The FIRST attempt record is held on a
    // gate; the other post runs attempt → send → posted-failure and
    // flips auditState to "error". When the gate releases, the held
    // post must stop BEFORE channel.send — leaving only its orphan
    // attempt record, never an unlinked public message.
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let attemptCalls = 0;
    const audit = makeAudit({
      record: vi.fn(async (input: { kind: string }) => {
        if (input.kind === "attempt") {
          attemptCalls += 1;
          if (attemptCalls === 1) {
            await gate;
          }
        }
        if (input.kind === "posted") {
          throw new Error("disk full");
        }
      }),
    });
    const { service } = makeDeps({ channel, config: auditConfig(), audit });

    const p1 = service.post(INPUT);
    const p2 = service.post({ ...INPUT, userId: "user-2" });
    await vi.waitFor(() => expect(attemptCalls).toBeGreaterThanOrEqual(1));
    await vi.waitFor(() => expect(service.auditState).toBe("error"));
    releaseGate?.();

    const results = await Promise.all([p1, p2]);
    expect(results.filter((r) => r.ok)).toHaveLength(0);
    expect(results.filter((r) => !r.ok && r.reason === "audit_failed")).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "unavailable")).toHaveLength(1);
    // Exactly one public send happened — the post whose posted-record
    // failed (its message was deleted best-effort). The gated post
    // never reached Discord.
    expect(send).toHaveBeenCalledTimes(1);
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

describe("anonymous-chat service — auditState", () => {
  it("reports disabled when no audit config and no injected sink", () => {
    const { service } = makeDeps({ audit: null });
    expect(service.auditState).toBe("disabled");
  });

  it("refuses ALL posts when audit is disabled — no unlogged posting mode", async () => {
    const { channel, send } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
    });
    const { service } = makeDeps({ channel, audit: null });
    expect(service.auditState).toBe("disabled");
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "unavailable" });
    expect(send).not.toHaveBeenCalled();
  });

  it("reports active when an audit sink is injected", () => {
    const { service } = makeDeps({
      audit: {
        seal: () => "ct",
        record: async () => undefined,
        sweep: async () => undefined,
      },
    });
    expect(service.auditState).toBe("active");
  });

  it("reports error when configured audit keys cannot build a sink", () => {
    const { service } = makeDeps({
      config: makeConfig({
        audit: {
          publicKey: "not-valid-key-material",
          keyId: "v1",
          dir: "data/anon-audit",
          retentionDays: 90,
        },
      }),
    });
    expect(service.auditState).toBe("error");
  });

  it("refuses ALL posts when audit is configured but broken — no ephemeral fallback", async () => {
    const { channel, send } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
    });
    const { service } = makeDeps({
      channel,
      config: makeConfig({
        audit: {
          publicKey: "not-valid-key-material",
          keyId: "v1",
          dir: "data/anon-audit",
          retentionDays: 90,
        },
      }),
    });
    expect(service.auditState).toBe("error");
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "unavailable" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("anonymous-chat service — private thread moderator path", () => {
  function makePrivateThread(botBits: AnonBits, userBits: AnonBits) {
    const { channel: parent } = makeChannel({
      id: "parent-1",
      permsByMemberId: { "user-1": userBits, "bot-1": botBits },
    });
    const { channel, send } = makeChannel({
      type: ChannelType.PrivateThread,
      permsByMemberId: {},
    });
    channel.parent = parent;
    channel.parentId = "parent-1";
    channel.locked = false;
    const fetchChannel = async (id: string) =>
      id === "parent-1" ? parent : id === channel.id ? channel : null;
    return { channel, send, fetchChannel };
  }

  it("allows a non-member user who holds ManageThreads", async () => {
    const { channel, send, fetchChannel } = makePrivateThread(
      bitsOf(VIEW, SEND_THREAD, MANAGE_THREADS), // bot can moderate
      bitsOf(VIEW, SEND_THREAD, MANAGE_THREADS), // user can moderate
    );
    const { service } = makeDeps({
      channel,
      fetchChannel,
      isThreadMember: async () => false, // nobody is a member
    });
    expect((await service.post(INPUT)).ok).toBe(true);
    expect(send).toHaveBeenCalled();
  });

  it("denies a non-member user without ManageThreads", async () => {
    const { channel, send, fetchChannel } = makePrivateThread(
      bitsOf(VIEW, SEND_THREAD),
      bitsOf(VIEW, SEND_THREAD),
    );
    const { service } = makeDeps({
      channel,
      fetchChannel,
      isThreadMember: async () => false,
    });
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("anonymous-chat service — permission freshness", () => {
  it("re-resolves permissions on every post — a revocation denies the next attempt", async () => {
    let now = 0;
    const perms: Record<string, AnonBits | null> = {
      "user-1": bitsOf(VIEW, SEND),
      "bot-1": bitsOf(VIEW, SEND),
    };
    const { channel, send } = makeChannel({ permsByMemberId: perms });
    const { service } = makeDeps({ channel, now: () => now });

    expect((await service.post(INPUT)).ok).toBe(true);
    // Permission revoked between posts; cooldown window passes.
    perms["user-1"] = bitsOf(VIEW);
    now += 31_000;
    expect(await service.post(INPUT)).toEqual({ ok: false, reason: "denied" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("anonymous-chat service — error sanitization", () => {
  it("logs only safe fields when channel.send throws a payload-bearing error", async () => {
    const leaky = Object.assign(new Error("DiscordAPIError: cannot send user-1 body-secret-body"), {
      name: "DiscordAPIError",
      code: 50013,
      status: 403,
      rawError: { content: "body-secret-body", author: { id: "user-1" } },
    });
    const { channel } = makeChannel({
      permsByMemberId: { "user-1": bitsOf(VIEW, SEND), "bot-1": bitsOf(VIEW, SEND) },
      sendImpl: async () => {
        throw leaky;
      },
    });
    const { service, logger } = makeDeps({ channel });
    const result = await service.post(INPUT);
    expect(result).toEqual({ ok: false, reason: "post_failed" });
    expect(logger.warn).toHaveBeenCalled();
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain("user-1");
    expect(logged).not.toContain("body-secret-body");
    expect(logged).not.toContain("rawError");
    const fields = logger.warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(fields.errName).toBe("DiscordAPIError");
    expect(fields.errCode).toBe(50013);
    expect(fields.errStatus).toBe(403);
  });
});

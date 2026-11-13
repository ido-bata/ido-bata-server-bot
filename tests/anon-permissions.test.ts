import { ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  type AnonBits,
  type AnonChannelLike,
  type AnonGuildLike,
  type AnonMemberLike,
  canPostWith,
  isPrivateThread,
  isThreadChannel,
  requiredSendBit,
  resolveEffectivePermissions,
} from "../src/features/anonymous-chat/permissions.js";

const VIEW = PermissionFlagsBits.ViewChannel;
const SEND = PermissionFlagsBits.SendMessages;
const SEND_THREAD = PermissionFlagsBits.SendMessagesInThreads;
const ADMIN = PermissionFlagsBits.Administrator;

function bitsOf(...flags: bigint[]): AnonBits {
  const bitfield = flags.reduce((acc, flag) => acc | flag, 0n);
  return new PermissionsBitField(bitfield) as unknown as AnonBits;
}

function member(id: string, perms: bigint[] = [], roleIds: string[] = []): AnonMemberLike {
  const roleSet = new Set(roleIds);
  const permBits = bitsOf(...perms);
  return {
    id,
    permissions: { has: (bit) => permBits.has(bit) },
    roles: { cache: { has: (roleId) => roleSet.has(roleId) } },
  };
}

const GUILD: AnonGuildLike = { id: "guild-1", ownerId: "owner-1" };

function textChannel(permsFor: AnonChannelLike["permissionsFor"]): AnonChannelLike {
  return {
    id: "chan-1",
    guildId: "guild-1",
    type: ChannelType.GuildText,
    parent: null,
    parentId: null,
    isTextBased: () => true,
    permissionsFor: permsFor,
    send: vi.fn(async () => ({ id: "m1", delete: async () => undefined })),
  };
}

function threadChannel(args: {
  type?: number;
  parent?: AnonChannelLike | null;
  parentId?: string | null;
}): AnonChannelLike {
  return {
    id: "thread-1",
    guildId: "guild-1",
    type: args.type ?? ChannelType.PublicThread,
    parent: args.parent ?? null,
    parentId: args.parentId ?? null,
    isTextBased: () => true,
    // discord.js ThreadChannel.permissionsFor delegates to the parent;
    // the resolver must not rely on the thread's own result.
    permissionsFor: () => null,
    send: vi.fn(async () => ({ id: "m1", delete: async () => undefined })),
  };
}

const fetchChannelNull = async () => null;

describe("requiredSendBit / channel classification", () => {
  it("requires SendMessages for text channels and SendMessagesInThreads for threads", () => {
    expect(requiredSendBit(textChannel(() => null))).toBe(SEND);
    expect(requiredSendBit(threadChannel({}))).toBe(SEND_THREAD);
    expect(isThreadChannel(threadChannel({}))).toBe(true);
    expect(isThreadChannel(textChannel(() => null))).toBe(false);
    expect(isPrivateThread(threadChannel({ type: ChannelType.PrivateThread }))).toBe(true);
    expect(isPrivateThread(threadChannel({}))).toBe(false);
  });
});

describe("resolveEffectivePermissions — non-thread channels", () => {
  it("returns the channel's permissionsFor result verbatim", async () => {
    const expected = bitsOf(VIEW, SEND);
    const channel = textChannel(() => expected);
    const result = await resolveEffectivePermissions({
      channel,
      member: member("u1"),
      guild: GUILD,
      fetchChannel: fetchChannelNull,
    });
    expect(result).toBe(expected);
  });

  it("returns null when permissionsFor cannot resolve the member", async () => {
    const channel = textChannel(() => null);
    const result = await resolveEffectivePermissions({
      channel,
      member: member("u1"),
      guild: GUILD,
      fetchChannel: fetchChannelNull,
    });
    expect(result).toBeNull();
  });
});

describe("resolveEffectivePermissions — admin / owner bypass", () => {
  it("returns all permissions for the guild owner", async () => {
    const channel = textChannel(() => bitsOf(VIEW)); // would deny send
    const result = await resolveEffectivePermissions({
      channel,
      member: member("owner-1"),
      guild: GUILD,
      fetchChannel: fetchChannelNull,
    });
    expect(result?.has(SEND)).toBe(true);
    expect(result?.has(VIEW)).toBe(true);
  });

  it("returns all permissions for an administrator", async () => {
    const channel = textChannel(() => bitsOf(VIEW)); // would deny send
    const result = await resolveEffectivePermissions({
      channel,
      member: member("admin-1", [ADMIN]),
      guild: GUILD,
      fetchChannel: fetchChannelNull,
    });
    expect(result?.has(SEND)).toBe(true);
  });
});

describe("resolveEffectivePermissions — member timeout", () => {
  // Discord timeouts are not permission bits: permissionsFor ignores
  // communicationDisabledUntil, but a timed-out member cannot send
  // messages — even admins. /anon must mirror that.
  it("denies a timed-out regular member even when bits allow sending", async () => {
    const channel = textChannel(() => bitsOf(VIEW, SEND));
    const timedOut = {
      ...member("user-1"),
      communicationDisabledUntilTimestamp: Date.now() + 60_000,
    };
    const result = await resolveEffectivePermissions({
      channel,
      member: timedOut,
      guild: GUILD,
      fetchChannel: fetchChannelNull,
    });
    expect(result).toBeNull();
  });

  it("denies a timed-out admin/owner — timeout applies to everyone", async () => {
    const channel = textChannel(() => bitsOf(VIEW, SEND));
    const timedOutAdmin = {
      ...member("admin-1", [ADMIN]),
      communicationDisabledUntilTimestamp: Date.now() + 60_000,
    };
    const result = await resolveEffectivePermissions({
      channel,
      member: timedOutAdmin,
      guild: GUILD,
      fetchChannel: fetchChannelNull,
    });
    expect(result).toBeNull();
  });

  it("allows a member whose timeout already expired", async () => {
    const channel = textChannel(() => bitsOf(VIEW, SEND));
    const expired = { ...member("user-1"), communicationDisabledUntilTimestamp: Date.now() - 1 };
    const result = await resolveEffectivePermissions({
      channel,
      member: expired,
      guild: GUILD,
      fetchChannel: fetchChannelNull,
    });
    expect(result?.has(SEND)).toBe(true);
  });

  it("treats missing/null timeout as not timed out", async () => {
    const channel = textChannel(() => bitsOf(VIEW, SEND));
    for (const until of [undefined, null]) {
      const m = { ...member("user-1"), communicationDisabledUntilTimestamp: until };
      const result = await resolveEffectivePermissions({
        channel,
        member: m,
        guild: GUILD,
        fetchChannel: fetchChannelNull,
      });
      expect(result?.has(SEND)).toBe(true);
    }
  });
});

describe("resolveEffectivePermissions — threads", () => {
  // Discord threads carry no permission_overwrites; permissions come
  // wholesale from the parent channel (discord.js delegates likewise).
  // The parent is ALWAYS resolved through the fresh-fetch adapter —
  // a cached `thread.parent` can hold stale overwrites.
  it("always fetches the parent fresh, ignoring stale cached parent bits", async () => {
    const staleParent = textChannel(() => bitsOf(VIEW)); // cached: no send
    const freshParent = { ...textChannel(() => bitsOf(VIEW, SEND_THREAD)), id: "parent-1" };
    const channel = threadChannel({ parent: staleParent, parentId: "parent-1" });
    const fetchChannel = vi.fn(async (id: string) => (id === "parent-1" ? freshParent : null));
    const result = await resolveEffectivePermissions({
      channel,
      member: member("u1"),
      guild: GUILD,
      fetchChannel,
    });
    expect(fetchChannel).toHaveBeenCalledWith("parent-1");
    expect(result?.has(SEND_THREAD)).toBe(true);
  });

  it("denies when the fresh parent revoked what the cached parent allowed", async () => {
    const staleParent = textChannel(() => bitsOf(VIEW, SEND_THREAD)); // cached: allow
    const freshParent = {
      ...textChannel(() => bitsOf(VIEW)), // fresh: send revoked
      id: "parent-1",
    };
    const channel = threadChannel({ parent: staleParent, parentId: "parent-1" });
    const fetchChannel = async (id: string) => (id === "parent-1" ? freshParent : null);
    const result = await resolveEffectivePermissions({
      channel,
      member: member("u1"),
      guild: GUILD,
      fetchChannel,
    });
    expect(result?.has(SEND_THREAD)).toBe(false);
  });

  it("returns null when the parent cannot be resolved (fail closed)", async () => {
    const channel = threadChannel({ parent: null, parentId: "missing" });
    const result = await resolveEffectivePermissions({
      channel,
      member: member("u1"),
      guild: GUILD,
      fetchChannel: fetchChannelNull,
    });
    expect(result).toBeNull();
  });

  it("returns null when the thread has no parentId", async () => {
    const channel = threadChannel({ parent: null, parentId: null });
    const result = await resolveEffectivePermissions({
      channel,
      member: member("u1"),
      guild: GUILD,
      fetchChannel: fetchChannelNull,
    });
    expect(result).toBeNull();
  });

  it("returns null when the fetched parent belongs to another guild", async () => {
    const foreignParent = {
      ...textChannel(() => bitsOf(VIEW, SEND_THREAD)),
      id: "parent-1",
      guildId: "guild-2",
    };
    const channel = threadChannel({ parent: null, parentId: "parent-1" });
    const fetchChannel = async () => foreignParent;
    const result = await resolveEffectivePermissions({
      channel,
      member: member("u1"),
      guild: GUILD,
      fetchChannel,
    });
    expect(result).toBeNull();
  });

  it("returns null when the parent's permissionsFor cannot resolve", async () => {
    const parent = { ...textChannel(() => null), id: "parent-1" };
    const channel = threadChannel({ parent: null, parentId: "parent-1" });
    const fetchChannel = async () => parent;
    const result = await resolveEffectivePermissions({
      channel,
      member: member("u1"),
      guild: GUILD,
      fetchChannel,
    });
    expect(result).toBeNull();
  });
});

describe("canPostWith", () => {
  it("requires both ViewChannel and the type-appropriate send bit", () => {
    const text = textChannel(() => null);
    const thread = threadChannel({});
    expect(canPostWith(text, bitsOf(VIEW, SEND))).toBe(true);
    expect(canPostWith(text, bitsOf(SEND))).toBe(false); // no view
    expect(canPostWith(text, bitsOf(VIEW))).toBe(false); // no send
    expect(canPostWith(thread, bitsOf(VIEW, SEND_THREAD))).toBe(true);
    expect(canPostWith(thread, bitsOf(VIEW, SEND))).toBe(false); // wrong send bit
  });
});

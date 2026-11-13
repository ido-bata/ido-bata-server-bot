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

describe("resolveEffectivePermissions — threads", () => {
  // Discord threads carry no permission_overwrites; permissions come
  // wholesale from the parent channel (discord.js delegates likewise).
  it("uses parent permissions when the thread is resolved inline", async () => {
    const parent = textChannel(() => bitsOf(VIEW, SEND_THREAD));
    const channel = threadChannel({ parent });
    const result = await resolveEffectivePermissions({
      channel,
      member: member("u1"),
      guild: GUILD,
      fetchChannel: fetchChannelNull,
    });
    expect(result?.has(SEND_THREAD)).toBe(true);
  });

  it("fetches the parent via fetchChannel when thread.parent is unresolved", async () => {
    const parent = textChannel(() => bitsOf(VIEW, SEND_THREAD));
    const channel = threadChannel({ parent: null, parentId: "parent-1" });
    const fetchChannel = vi.fn(async (id: string) => (id === "parent-1" ? parent : null));
    const result = await resolveEffectivePermissions({
      channel,
      member: member("u1"),
      guild: GUILD,
      fetchChannel,
    });
    expect(fetchChannel).toHaveBeenCalledWith("parent-1");
    expect(result?.has(SEND_THREAD)).toBe(true);
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

  it("returns null when the parent's permissionsFor cannot resolve", async () => {
    const parent = textChannel(() => null);
    const channel = threadChannel({ parent });
    const result = await resolveEffectivePermissions({
      channel,
      member: member("u1"),
      guild: GUILD,
      fetchChannel: fetchChannelNull,
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

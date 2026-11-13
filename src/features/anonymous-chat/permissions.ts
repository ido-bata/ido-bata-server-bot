/**
 * Effective-permission resolution for `/anon` (ADR-0003 §2).
 *
 * The rule is "the invoking member could post a normal message in this
 * channel/thread". We mirror discord.js `GuildChannel.memberPermissions`
 * ordering — role permissions, then `@everyone` overwrite, then role
 * overwrites, then the member overwrite — because
 * `interaction.memberPermissions` alone does not cover the bot-member
 * check and `ThreadChannel.permissionsFor` silently ignores thread-level
 * overwrites (it delegates to the parent only).
 *
 * Everything here is structural typing + pure logic so tests can drive
 * it with fakes; the discord.js adapter lives in `discord.ts`.
 */
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";

/** Minimal bitfield surface shared by `PermissionsBitField` and fakes. */
export type AnonBits = {
  has: (bit: bigint) => boolean;
  bitfield: bigint;
};

export type AnonOverwrite = {
  id: string;
  allow: { bitfield: bigint };
  deny: { bitfield: bigint };
};

export type AnonOverwriteManager = {
  cache: { values: () => Iterable<AnonOverwrite> };
};

export type AnonMemberLike = {
  id: string;
  permissions: { has: (bit: bigint) => boolean };
  roles: { cache: { has: (id: string) => boolean } };
};

export type AnonGuildLike = {
  id: string;
  ownerId: string;
};

export type AnonChannelLike = {
  id: string;
  guildId: string | null;
  type: number;
  parent: AnonChannelLike | null;
  parentId: string | null;
  archived?: boolean | null;
  locked?: boolean | null;
  isTextBased: () => boolean;
  permissionsFor: (subject: AnonMemberLike) => AnonBits | null;
  permissionOverwrites?: AnonOverwriteManager;
  members?: {
    cache: { has: (id: string) => boolean };
    fetch: (id: string) => Promise<unknown>;
  };
  send: (payload: {
    content: string;
    allowedMentions: { parse: never[] };
  }) => Promise<{ id: string; delete: () => Promise<unknown> }>;
};

const THREAD_TYPES: ReadonlySet<number> = new Set([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

export function isThreadChannel(channel: Pick<AnonChannelLike, "type">): boolean {
  return THREAD_TYPES.has(channel.type);
}

export function isPrivateThread(channel: Pick<AnonChannelLike, "type">): boolean {
  return channel.type === ChannelType.PrivateThread;
}

/** Send bit a normal member needs in this channel type. */
export function requiredSendBit(channel: Pick<AnonChannelLike, "type">): bigint {
  return isThreadChannel(channel)
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
}

function isAdminOrOwner(member: AnonMemberLike, guild: AnonGuildLike): boolean {
  return member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator);
}

function allPermissions(): PermissionsBitField {
  return new PermissionsBitField(PermissionsBitField.All);
}

/**
 * Apply a thread's own permission overwrites on top of the parent
 * channel's resolved permissions, mirroring discord.js ordering:
 * `@everyone` → role overwrites (deny union, then allow union) → member
 * overwrite. Admin/owner bypass is handled by the caller before this
 * runs, matching Discord semantics (administrators ignore overwrites).
 */
function applyThreadOverwrites(
  base: AnonBits,
  channel: AnonChannelLike,
  guild: AnonGuildLike,
  member: AnonMemberLike,
): AnonBits {
  const manager = channel.permissionOverwrites;
  if (!manager) {
    return base;
  }

  let everyoneDeny = 0n;
  let everyoneAllow = 0n;
  let rolesDeny = 0n;
  let rolesAllow = 0n;
  let memberOverwrite: AnonOverwrite | undefined;

  for (const overwrite of manager.cache.values()) {
    if (overwrite.id === guild.id) {
      everyoneDeny |= overwrite.deny.bitfield;
      everyoneAllow |= overwrite.allow.bitfield;
    } else if (member.roles.cache.has(overwrite.id)) {
      rolesDeny |= overwrite.deny.bitfield;
      rolesAllow |= overwrite.allow.bitfield;
    } else if (overwrite.id === member.id) {
      memberOverwrite = overwrite;
    }
  }

  let bits = new PermissionsBitField(base.bitfield);
  bits = bits.remove(everyoneDeny).add(everyoneAllow);
  bits = bits.remove(rolesDeny).add(rolesAllow);
  if (memberOverwrite) {
    bits = bits.remove(memberOverwrite.deny.bitfield).add(memberOverwrite.allow.bitfield);
  }
  return bits;
}

/**
 * Resolve a member's effective permissions on `channel`.
 *
 * Returns `null` when the computation cannot be completed (missing
 * parent, unresolvable member, API-shaped gap) — callers MUST treat
 * null as deny. Never throws for expected Discord shapes; unexpected
 * throws propagate to the service's fail-closed handler.
 */
export async function resolveEffectivePermissions(args: {
  channel: AnonChannelLike;
  member: AnonMemberLike;
  guild: AnonGuildLike;
  fetchChannel: (channelId: string) => Promise<AnonChannelLike | null>;
}): Promise<AnonBits | null> {
  const { channel, member, guild, fetchChannel } = args;

  if (isAdminOrOwner(member, guild)) {
    return allPermissions();
  }

  if (!isThreadChannel(channel)) {
    return channel.permissionsFor(member);
  }

  // discord.js ThreadChannel.permissionsFor only consults the parent;
  // thread-level overwrites are applied on top here.
  let parent = channel.parent;
  if (!parent && channel.parentId) {
    try {
      parent = await fetchChannel(channel.parentId);
    } catch {
      return null;
    }
  }
  if (!parent) {
    return null;
  }

  const base = parent.permissionsFor(member);
  if (!base) {
    return null;
  }
  return applyThreadOverwrites(base, channel, guild, member);
}

/** Whether the member satisfies the posting requirement on resolved bits. */
export function canPostWith(channel: Pick<AnonChannelLike, "type">, bits: AnonBits): boolean {
  return bits.has(PermissionFlagsBits.ViewChannel) && bits.has(requiredSendBit(channel));
}

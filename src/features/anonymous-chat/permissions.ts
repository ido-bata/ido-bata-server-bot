/**
 * Effective-permission resolution for `/anon` (ADR-0003 §2).
 *
 * The rule is "the invoking member could post a normal message in this
 * channel/thread". We mirror discord.js `GuildChannel.memberPermissions`
 * ordering — role permissions, then `@everyone` overwrite, then role
 * overwrites, then the member overwrite — because
 * `interaction.memberPermissions` alone does not cover the bot-member
 * check and keeps the logic testable via DI.
 *
 * Discord threads do NOT have their own permission overwrites: a
 * thread inherits the parent channel's overwrites wholesale, and
 * discord.js `ThreadChannel.permissionsFor` reflects exactly that (it
 * delegates to the parent). Private threads are gated by membership,
 * not overwrites. So for threads we resolve `parent.permissionsFor`
 * and nothing more.
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

export type AnonMemberLike = {
  id: string;
  permissions: { has: (bit: bigint) => boolean };
  roles: { cache: { has: (id: string) => boolean } };
  /** GuildMember.communicationDisabledUntilTimestamp (ms epoch, null = none). */
  communicationDisabledUntilTimestamp?: number | null;
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

/**
 * Discord timeouts are NOT permission bits — `permissionsFor`
 * ignores `communicationDisabledUntil`, but a timed-out member
 * cannot send messages at all (the restriction applies even to
 * admins/owner). Checked before the admin/owner bypass so `/anon`
 * mirrors "could this member post normally".
 */
function isTimedOut(member: AnonMemberLike, now: number = Date.now()): boolean {
  const until = member.communicationDisabledUntilTimestamp;
  return typeof until === "number" && until > now;
}

function allPermissions(): PermissionsBitField {
  return new PermissionsBitField(PermissionsBitField.All);
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

  if (isTimedOut(member)) {
    return null;
  }

  if (isAdminOrOwner(member, guild)) {
    return allPermissions();
  }

  if (!isThreadChannel(channel)) {
    return channel.permissionsFor(member);
  }

  // Threads inherit the parent channel's permission overwrites;
  // discord.js ThreadChannel.permissionsFor delegates to the parent,
  // which is exactly the semantics Discord applies. The parent is
  // ALWAYS resolved through the fresh-fetch adapter: the thread's
  // cached `parent` can carry stale overwrites even when the thread
  // itself was just re-fetched, and this decision must reflect the
  // current permission state. Private-thread membership is checked
  // separately by the service.
  if (!channel.parentId) {
    return null;
  }
  let parent: AnonChannelLike | null;
  try {
    parent = await fetchChannel(channel.parentId);
  } catch {
    return null;
  }
  if (!parent || parent.guildId !== guild.id) {
    return null;
  }

  return parent.permissionsFor(member);
}

/** Whether the member satisfies the posting requirement on resolved bits. */
export function canPostWith(channel: Pick<AnonChannelLike, "type">, bits: AnonBits): boolean {
  return bits.has(PermissionFlagsBits.ViewChannel) && bits.has(requiredSendBit(channel));
}

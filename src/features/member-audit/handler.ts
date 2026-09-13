import type { Client, GuildMember, PartialGuildMember } from "discord.js";
import { Events } from "discord.js";

import { isMemberAuditConfigured, type MemberAuditConfig } from "./config.js";
import { formatJoinAudit, formatLeaveAudit } from "./template.js";

export type MemberAuditDeps = {
  config: MemberAuditConfig;
  sendMessage?: (channelId: string, content: string) => Promise<void>;
  log?: (message: string) => void;
};

export type JoinAuditEvent = {
  memberId: string;
  memberName: string;
  isBot: boolean;
  joinedAt: Date;
  accountCreatedAt: Date | null;
};

export type LeaveAuditEvent = {
  memberId: string;
  memberName: string;
  isBot: boolean;
  leftAt: Date;
};

export function createMemberAuditHandler(deps: MemberAuditDeps) {
  const { config } = deps;
  const sendMessage = deps.sendMessage;
  const log = deps.log ?? (() => {});
  const configured = isMemberAuditConfigured(config);

  async function postOrLog(channelId: string, content: string): Promise<void> {
    if (!sendMessage) {
      return;
    }

    try {
      await sendMessage(channelId, content);
    } catch (error) {
      log(
        `member-audit: failed to post audit message: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function onMemberJoin(event: JoinAuditEvent): Promise<void> {
    if (!configured || event.isBot) {
      return;
    }

    const content = formatJoinAudit({
      memberName: event.memberName,
      joinedAt: event.joinedAt,
      accountCreatedAt: event.accountCreatedAt,
    });
    await postOrLog(config.channelId, content);
  }

  async function onMemberLeave(event: LeaveAuditEvent): Promise<void> {
    if (!configured || event.isBot) {
      return;
    }

    const content = formatLeaveAudit({
      memberName: event.memberName,
      leftAt: event.leftAt,
    });
    await postOrLog(config.channelId, content);
  }

  return {
    isConfigured: () => configured,
    onMemberJoin,
    onMemberLeave,
  };
}

function isPartialMember(member: GuildMember | PartialGuildMember): member is PartialGuildMember {
  return member.partial === true;
}

export function registerMemberAuditHandlers(
  client: Client,
  deps: Omit<MemberAuditDeps, "config"> & { config: MemberAuditConfig },
): void {
  const handler = createMemberAuditHandler(deps);

  client.on(Events.GuildMemberAdd, async (member) => {
    await handler.onMemberJoin({
      memberId: member.id,
      memberName: member.user?.username ?? member.displayName,
      isBot: member.user?.bot ?? false,
      joinedAt: member.joinedAt ?? new Date(),
      accountCreatedAt: member.user?.createdAt ?? null,
    });
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    const resolved = isPartialMember(member) ? await member.fetch().catch(() => member) : member;
    await handler.onMemberLeave({
      memberId: resolved.id,
      memberName: resolved.user?.username ?? resolved.displayName,
      isBot: resolved.user?.bot ?? false,
      leftAt: new Date(),
    });
  });
}

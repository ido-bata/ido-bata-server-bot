import { SlashCommandBuilder } from "discord.js";

import type { AnonymousChatService } from "../../anonymous-chat/service.js";
import type { SlashCommandDefinition } from "../types.js";

export type AnonCommandDeps = {
  service?: AnonymousChatService;
};

const REPLY_SUCCESS = "匿名メッセージを投稿しました。";
const REPLY_DENIED = "この場所には匿名投稿できません。";
const REPLY_COOLDOWN = "連続して投稿することはできません。しばらく待ってから再度お試しください。";
const REPLY_UNAVAILABLE = "現在匿名投稿を利用できません。時間をおいて再度お試しください。";

function replyFor(reason: string, retryAfterMs?: number): string {
  switch (reason) {
    case "cooldown":
      return retryAfterMs && retryAfterMs > 0
        ? `${REPLY_COOLDOWN}（あと約${Math.ceil(retryAfterMs / 1000)}秒）`
        : REPLY_COOLDOWN;
    case "invalid_message":
    case "denied":
      return REPLY_DENIED;
    default:
      // `bot_permission_denied`, `unavailable`, `post_failed`,
      // `audit_failed` all map to the generic reply — no bot-config or
      // channel-state detail leaks to the caller (ADR-0003 §1/§2).
      return REPLY_UNAVAILABLE;
  }
}

export const anonCommand: SlashCommandDefinition = {
  name: "anon",
  description: "Post a message without revealing who sent it.",
  buildPayload: () =>
    new SlashCommandBuilder()
      .setName("anon")
      .setDescription("Post a message without revealing who sent it.")
      .addStringOption((option) =>
        option
          .setName("message")
          .setDescription("The message to post anonymously (1-1000 characters).")
          .setRequired(true),
      ) as unknown as SlashCommandBuilder,
  // The dispatcher types `deps` as `unknown`; we narrow to
  // `AnonCommandDeps` here. Every failure path replies with a generic
  // ephemeral message — this execute must NEVER throw, because the
  // InteractionCreate dispatcher has no error boundary and a throw
  // would forward the stack (potentially containing the user id) to
  // the error channel (ADR-0003 §4).
  //
  // Discord requires an interaction acknowledgement within ~3 s; the
  // permission pipeline performs several REST lookups, so we
  // `deferReply({ ephemeral: true })` immediately and deliver the
  // outcome via `editReply`. A successful public post is never
  // retried — if `editReply` fails after `post()` returned ok, the
  // anonymous message is already live and we simply stop.
  execute: (async ({ interaction }: { interaction: never; commandName: string }, deps: unknown) => {
    const typedInteraction = interaction as unknown as {
      inGuild: () => boolean;
      guildId: string | null;
      channelId: string | null;
      user: { id: string };
      options: { getString: (name: string, required?: boolean) => string | null };
      deferReply: (options: { ephemeral?: boolean }) => Promise<unknown>;
      editReply: (options: { content: string }) => Promise<unknown>;
      reply?: (options: { content: string; ephemeral?: boolean }) => Promise<unknown>;
    };

    // Acknowledge within the 3-second window before doing any work.
    try {
      await typedInteraction.deferReply({ ephemeral: true });
    } catch {
      // The interaction is likely already acknowledged or expired —
      // one last generic `reply` attempt, fully isolated so a sync
      // throw can never escape into the dispatcher.
      await Promise.resolve()
        .then(() => typedInteraction.reply?.({ content: REPLY_UNAVAILABLE, ephemeral: true }))
        .catch(() => undefined);
      return;
    }

    const edit = async (content: string) => {
      try {
        await typedInteraction.editReply({ content });
      } catch {
        // Response delivery failed. If the post already succeeded the
        // anonymous message is live — never retry `post()` (that would
        // double-post and double-spend the cooldown). Swallow.
      }
    };

    try {
      const service = (deps as AnonCommandDeps | undefined)?.service;
      if (!service) {
        await edit(REPLY_UNAVAILABLE);
        return;
      }
      if (!typedInteraction.inGuild() || !typedInteraction.guildId || !typedInteraction.channelId) {
        await edit(REPLY_DENIED);
        return;
      }

      const message = typedInteraction.options.getString("message", true);
      if (message === null) {
        await edit(REPLY_UNAVAILABLE);
        return;
      }

      const result = await service.post({
        userId: typedInteraction.user.id,
        guildId: typedInteraction.guildId,
        channelId: typedInteraction.channelId,
        message,
      });

      await edit(result.ok ? REPLY_SUCCESS : replyFor(result.reason, result.retryAfterMs));
    } catch {
      await edit(REPLY_UNAVAILABLE);
    }
  }) as SlashCommandDefinition["execute"],
};

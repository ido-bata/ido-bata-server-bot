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
  execute: (async ({ interaction }: { interaction: never; commandName: string }, deps: unknown) => {
    const typedInteraction = interaction as unknown as {
      inGuild: () => boolean;
      guildId: string | null;
      channelId: string | null;
      user: { id: string };
      options: { getString: (name: string, required?: boolean) => string | null };
      reply: (options: { content: string; ephemeral?: boolean }) => Promise<unknown>;
    };
    const reply = (content: string) => typedInteraction.reply({ content, ephemeral: true });

    try {
      const service = (deps as AnonCommandDeps | undefined)?.service;
      if (!service) {
        await reply(REPLY_UNAVAILABLE);
        return;
      }
      if (!typedInteraction.inGuild() || !typedInteraction.guildId || !typedInteraction.channelId) {
        await reply(REPLY_DENIED);
        return;
      }

      const message = typedInteraction.options.getString("message", true);
      if (message === null) {
        await reply(REPLY_UNAVAILABLE);
        return;
      }

      const result = await service.post({
        userId: typedInteraction.user.id,
        guildId: typedInteraction.guildId,
        channelId: typedInteraction.channelId,
        message,
      });

      if (result.ok) {
        await reply(REPLY_SUCCESS);
        return;
      }
      await reply(replyFor(result.reason, result.retryAfterMs));
    } catch {
      // Last-resort guard: reply generically, never propagate — not
      // even if `reply` itself throws synchronously.
      await Promise.resolve()
        .then(() => reply(REPLY_UNAVAILABLE))
        .catch(() => undefined);
    }
  }) as SlashCommandDefinition["execute"],
};

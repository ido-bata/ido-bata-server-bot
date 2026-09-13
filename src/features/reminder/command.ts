import { SlashCommandBuilder } from "discord.js";

import { reminderConfig } from "./config.js";
import { formatDurationVerbose, parseDuration } from "./duration.js";
import type { ReminderQueue } from "./service.js";

type ChatInputCommandInteractionLike = {
  options: {
    // Mirror the discord.js overloads so `required: true` narrows to `string`.
    getString(name: string, required: true): string;
    getString(name: string, required?: boolean): string | null;
  };
  user: { id: string };
  reply: (options: { content: string; ephemeral?: boolean }) => Promise<unknown>;
};

export type RemindCommandDeps = {
  now?: () => Date;
  /**
   * Resolved at runtime; lets tests substitute an in-memory queue.
   */
  queue: Pick<ReminderQueue, "add" | "countForUser">;
};

/**
 * Format a JST-friendly absolute timestamp for the confirmation reply. We use
 * the Asia/Tokyo time zone so users see their wall-clock time regardless of
 * where the bot is hosted.
 */
function formatJstTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export const remindCommandName = "remind" as const;

export const remindCommandBuilder = new SlashCommandBuilder()
  .setName(remindCommandName)
  .setDescription("指定時間後に DM でリマインドします。例: /remind me in 30m \"check oven\"")
  .addStringOption((option) =>
    option
      .setName("duration")
      .setDescription("待機時間 (例: 30m, 1h30m, 2d)")
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("message")
      .setDescription("リマインド本文")
      .setRequired(true)
      .setMaxLength(500),
  );

export async function executeRemindCommand(
  interaction: ChatInputCommandInteractionLike,
  deps: RemindCommandDeps,
): Promise<unknown> {
  const durationRaw = interaction.options.getString("duration", true);
  const messageRaw = interaction.options.getString("message", true);

  const duration = parseDuration(durationRaw);

  if (!duration.ok) {
    return interaction.reply({
      content: `duration の解釈に失敗しました: ${duration.error}`,
      ephemeral: true,
    });
  }

  const now = (deps.now ?? (() => new Date()))();
  const fireAt = new Date(now.getTime() + duration.durationMs);

  if (fireAt.getTime() <= now.getTime()) {
    return interaction.reply({
      content: "duration が短すぎるか、過去になります。1 秒以上未来を指定してください。",
      ephemeral: true,
    });
  }

  if (duration.durationMs > reminderConfig.maxDurationMs) {
    const maxLabel = formatDurationVerbose(reminderConfig.maxDurationMs);
    return interaction.reply({
      content: `duration が長すぎます。上限は ${maxLabel} (${reminderConfig.maxDurationMs}ms) です。`,
      ephemeral: true,
    });
  }

  const message = messageRaw.trim();
  if (message.length === 0) {
    return interaction.reply({
      content: "message が空です。本文を指定してください。",
      ephemeral: true,
    });
  }

  const currentCount = deps.queue.countForUser(interaction.user.id);
  if (currentCount >= reminderConfig.maxPerUser) {
    return interaction.reply({
      content: `1 ユーザーあたりの reminder 上限 (${reminderConfig.maxPerUser} 件) に達しています。発火済みのものを整理してから再度登録してください。`,
      ephemeral: true,
    });
  }

  const result = deps.queue.add({
    userId: interaction.user.id,
    message,
    fireAt,
    createdAt: now,
  });

  if (!result.ok) {
    return interaction.reply({
      content: `reminder の登録に失敗しました: ${result.error}`,
      ephemeral: true,
    });
  }

  return interaction.reply({
    content: [
      `登録しました: ${formatJstTimestamp(fireAt)} JST 頃 (${formatDurationVerbose(duration.durationMs)}) に DM で送ります。`,
      `内容: ${message}`,
    ].join("\n"),
    ephemeral: true,
  });
}

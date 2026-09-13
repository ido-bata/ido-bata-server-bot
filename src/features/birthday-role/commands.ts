// Minimal slash-command surface for the birthday-role feature. This is
// intentionally self-contained so the feature does not depend on the
// separate slash-commands base (#13) landing first. When that base is
// available, the same handler shape can be moved into a shared registry.

import type {
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandSubcommandsOnlyBuilder } from "discord.js";

import type { BirthdayRoleHandler } from "./handler.js";

export type BirthdayCommandName = "birthday";

export type BirthdayCommandContext = {
  interaction: ChatInputCommandInteraction;
  commandName: string;
};

export type BirthdayCommandBuilder =
  | SlashCommandBuilder
  | SlashCommandSubcommandsOnlyBuilder;

export type BirthdayCommandDefinition = {
  name: BirthdayCommandName;
  description: string;
  buildPayload: () => RESTPostAPIChatInputApplicationCommandsJSONBody | BirthdayCommandBuilder;
  execute: (context: BirthdayCommandContext, deps: BirthdayCommandDeps) => Promise<void>;
};

export type BirthdayCommandDeps = {
  handler: BirthdayRoleHandler;
  // Lets the test inject an InteractionLike without a live Client.
  resolveDateOption?: (raw: unknown) => string | null;
};

type InteractionLike = {
  commandName: string;
  user: { id: string };
  options: {
    getSubcommand: (name: string) => boolean;
    getString: (name: string) => string | null;
  };
  reply: (options: { content: string; ephemeral?: boolean }) => Promise<unknown>;
};

function buildBirthdayPayload(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("birthday")
    .setDescription("誕生日の登録・取り消し")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("誕生日を登録")
        .addStringOption((option) =>
          option.setName("date").setDescription("誕生日 (YYYY-MM-DD)").setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName("remove").setDescription("誕生日登録を取り消し"));
}

export const birthdayCommand: BirthdayCommandDefinition = {
  name: "birthday",
  description: "誕生日の登録・取り消し",
  buildPayload: buildBirthdayPayload,
  execute: async ({ interaction }, deps) => {
    await dispatchBirthdayInteraction(interaction as unknown as InteractionLike, deps);
  },
};

async function dispatchBirthdayInteraction(
  interaction: InteractionLike,
  deps: BirthdayCommandDeps,
): Promise<void> {
  const resolveDate = deps.resolveDateOption ?? defaultResolveDate;

  if (interaction.options.getSubcommand("set")) {
    const raw = resolveDate(interaction);

    if (raw === null) {
      await interaction.reply({
        content: "誕生日を YYYY-MM-DD 形式で入力してください。",
        ephemeral: true,
      });
      return;
    }

    const result = await deps.handler.setBirthday(interaction.user.id, raw);

    if (!result.ok) {
      await interaction.reply({
        content: result.reason === "invalid-date"
          ? "誕生日の形式が正しくありません (YYYY-MM-DD)。"
          : "誕生日の保存に失敗しました。",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: `${result.entry.date} として誕生日を登録しました。`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.options.getSubcommand("remove")) {
    const result = await deps.handler.removeBirthday(interaction.user.id);
    await interaction.reply({
      content: result.removed
        ? "誕生日の登録を取り消しました。"
        : "誕生日は登録されていません。",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({ content: "unknown subcommand", ephemeral: true });
}

function defaultResolveDate(raw: unknown): string | null {
  // The Discord interaction exposes `.options.getString('date')` returning
  // `string | null`. This shim exists so tests can pass any object that
  // exposes the same shape.
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const value = (raw as { options?: { getString?: (name: string) => string | null } }).options
    ?.getString?.("date");

  return typeof value === "string" && value.length > 0 ? value : null;
}

export type BirthdayCommandRegistry = {
  definitions: BirthdayCommandDefinition[];
  find: (name: string) => BirthdayCommandDefinition | undefined;
};

export function createBirthdayCommandRegistry(
  definitions: BirthdayCommandDefinition[] = [birthdayCommand],
): BirthdayCommandRegistry {
  const byName = new Map<string, BirthdayCommandDefinition>(
    definitions.map((definition) => [definition.name, definition]),
  );
  return {
    definitions: [...definitions],
    find: (name: string) => byName.get(name),
  };
}

import type { ChatInputCommandInteraction, Client, Interaction } from "discord.js";
import { SlashCommandBuilder } from "discord.js";

import type { CalendarService } from "./service.js";

export type ReplyableInteraction = {
  reply: (options: string | { content?: string; ephemeral?: boolean }) => Promise<unknown>;
};

export type CalendarSlashCommand = {
  buildSlashCommand: () => ReturnType<SlashCommandBuilder["toJSON"]>;
  handleInteraction: (
    interaction: Pick<ChatInputCommandInteraction, "options" | "reply">,
    service: CalendarService,
  ) => Promise<string>;
  matches: (interaction: Interaction) => boolean;
};

export function createCalendarSlashCommand(): CalendarSlashCommand {
  const data = new SlashCommandBuilder()
    .setName("calendar")
    .setDescription("カレンダー連携")
    .addSubcommand((sub) => sub.setName("list").setDescription("直近のイベントを一覧表示します"))
    .addSubcommand((sub) =>
      sub
        .setName("show")
        .setDescription("指定 ID のイベント詳細を表示します")
        .addStringOption((option) =>
          option.setName("id").setDescription("イベント ID").setRequired(true),
        ),
    );

  return {
    buildSlashCommand: () => data.toJSON(),
    matches(interaction: Interaction): boolean {
      if (!interaction.isChatInputCommand?.()) {
        return false;
      }
      return interaction.commandName === "calendar";
    },
    async handleInteraction(interaction, service): Promise<string> {
      const sub = interaction.options.getSubcommand();
      const sourceNames = service.buildSourceNameMap();

      if (sub === "list") {
        const events = service.listUpcomingEvents();
        return service.formatList(events, sourceNames);
      }

      if (sub === "show") {
        const id = interaction.options.getString("id", true);
        const event = service.resolveEvent(id);
        if (!event) {
          return `イベント ${id} は見つかりませんでした。`;
        }
        return service.formatShow(event);
      }

      return "不明なサブコマンドです。";
    },
  };
}

export type DiscordCalendarBinder = {
  bind: () => void;
};

export function bindDiscordCalendarCommands(
  client: Client,
  service: CalendarService,
): DiscordCalendarBinder {
  const command = createCalendarSlashCommand();

  return {
    bind() {
      client.on("interactionCreate", async (interaction) => {
        if (!command.matches(interaction)) {
          return;
        }
        try {
          const content = await command.handleInteraction(
            interaction as unknown as Pick<ChatInputCommandInteraction, "options" | "reply">,
            service,
          );
          await (interaction as unknown as ReplyableInteraction).reply({
            content,
            ephemeral: true,
          });
        } catch (error) {
          console.error("[ical-calendar] failed to handle interaction", error);
        }
      });
    },
  };
}

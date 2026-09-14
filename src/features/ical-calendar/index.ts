import type { Client } from "discord.js";

import type { SlashCommandRegistry } from "../../bot/slash-commands.js";
import { bindDiscordCalendarCommands, createCalendarSlashCommand } from "./discord.js";
import { type CalendarService, createCalendarService } from "./service.js";

export type RegisterOptions = {
  onReady?: (service: CalendarService) => void;
  service?: CalendarService;
  slashCommands?: SlashCommandRegistry;
};

export function registerIcalCalendar(
  client: Client,
  options: RegisterOptions = {},
): CalendarService {
  const service = options.service ?? createCalendarService();
  const command = createCalendarSlashCommand();
  bindDiscordCalendarCommands(client, service, command).bind();

  if (options.slashCommands) {
    options.slashCommands.register({
      name: command.buildSlashCommand().name,
      toJSON: command.buildSlashCommand,
    });
  }

  const onReady = options.onReady;
  if (onReady) {
    client.once("ready", () => {
      onReady(service);
    });
  }

  return service;
}

export * from "./config.js";
export * from "./discord.js";
export * from "./fetcher.js";
export * from "./format.js";
export * from "./logger.js";
export * from "./parser.js";
export * from "./service.js";
export * from "./types.js";

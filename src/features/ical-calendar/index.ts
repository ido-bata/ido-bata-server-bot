import type { Client } from "discord.js";

import { bindDiscordCalendarCommands } from "./discord.js";
import { type CalendarService, createCalendarService } from "./service.js";

export type RegisterOptions = {
  onReady?: (service: CalendarService) => void;
  service?: CalendarService;
};

export function registerIcalCalendar(
  client: Client,
  options: RegisterOptions = {},
): CalendarService {
  const service = options.service ?? createCalendarService();
  bindDiscordCalendarCommands(client, service).bind();

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

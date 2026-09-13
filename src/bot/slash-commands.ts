import type { RESTPostAPIApplicationCommandsJSONBody } from "discord.js";
import { REST, Routes } from "discord.js";

export type SlashCommandDefinition = {
  name: string;
  toJSON: () => RESTPostAPIApplicationCommandsJSONBody;
};

export type DeploySlashCommandsOptions = {
  clientId: string;
  guildId: string;
  token: string;
  rest?: Pick<REST, "put">;
};

export type SlashCommandRegistry = {
  register: (definition: SlashCommandDefinition) => void;
  list: () => SlashCommandDefinition[];
  deploy: (options: DeploySlashCommandsOptions) => Promise<void>;
};

export function createSlashCommandRegistry(): SlashCommandRegistry {
  const definitions = new Map<string, SlashCommandDefinition>();

  return {
    register(definition) {
      definitions.set(definition.name, definition);
    },
    list() {
      return Array.from(definitions.values());
    },
    async deploy(options) {
      const payload = Array.from(definitions.values()).map((definition) => definition.toJSON());
      const path = Routes.applicationGuildCommands(options.clientId, options.guildId);
      const rest = options.rest ?? new REST({ version: "10" }).setToken(options.token);
      await rest.put(path, { body: payload });
    },
  };
}

import { describe, expect, it, vi } from "vitest";

import { type BirthdayRoleConfig } from "../src/features/birthday-role/config.js";
import {
  birthdayCommand,
  createBirthdayCommandRegistry,
} from "../src/features/birthday-role/commands.js";
import { createBirthdayRoleHandler } from "../src/features/birthday-role/handler.js";
import { createInMemoryBirthdayStorage } from "../src/features/birthday-role/storage.js";

const CONFIG: BirthdayRoleConfig = {
  roleId: "role-birthday",
  announcementChannelId: "",
  dataFile: "unused",
};

type Interaction = {
  commandName: string;
  user: { id: string };
  options: {
    getSubcommand: (name: string) => boolean;
    getString: (name: string) => string | null;
  };
  reply: ReturnType<typeof vi.fn>;
};

function makeInteraction(
  commandName: string,
  userId: string,
  options: { subcommand: "set" | "remove"; date?: string | null } = { subcommand: "set" },
): Interaction {
  return {
    commandName,
    user: { id: userId },
    options: {
      getSubcommand: (name: string) => name === options.subcommand,
      getString: (name: string) => (name === "date" ? options.date ?? null : null),
    },
    reply: vi.fn(async () => undefined),
  };
}

describe("birthday-role commands", () => {
  it("registers a single /birthday command", () => {
    const registry = createBirthdayCommandRegistry();
    expect(registry.definitions.map((d) => d.name)).toEqual(["birthday"]);
    expect(registry.find("birthday")).toBeDefined();
  });

  it("/birthday set persists the date and replies with confirmation", async () => {
    const handler = createBirthdayRoleHandler({
      config: CONFIG,
      storage: createInMemoryBirthdayStorage(),
    });
    const interaction = makeInteraction("birthday", "user-1", {
      subcommand: "set",
      date: "1990-04-02",
    });

    await birthdayCommand.execute(
      {
        interaction: interaction as never,
        commandName: interaction.commandName,
      },
      { handler },
    );

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "1990-04-02 として誕生日を登録しました。",
      ephemeral: true,
    });
  });

  it("/birthday set replies with an error for invalid dates", async () => {
    const handler = createBirthdayRoleHandler({
      config: CONFIG,
      storage: createInMemoryBirthdayStorage(),
    });
    const interaction = makeInteraction("birthday", "user-1", {
      subcommand: "set",
      date: "not-a-date",
    });

    await birthdayCommand.execute(
      {
        interaction: interaction as never,
        commandName: interaction.commandName,
      },
      { handler },
    );

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "誕生日の形式が正しくありません (YYYY-MM-DD)。",
      ephemeral: true,
    });
  });

  it("/birthday remove cancels an existing registration", async () => {
    const storage = createInMemoryBirthdayStorage({
      birthdays: {
        "user-1": {
          userId: "user-1",
          date: "1990-04-02",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      },
    });
    const handler = createBirthdayRoleHandler({ config: CONFIG, storage });
    const interaction = makeInteraction("birthday", "user-1", { subcommand: "remove" });

    await birthdayCommand.execute(
      {
        interaction: interaction as never,
        commandName: interaction.commandName,
      },
      { handler },
    );

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "誕生日の登録を取り消しました。",
      ephemeral: true,
    });
    const reloaded = await storage.load();
    expect(reloaded.birthdays).toEqual({});
  });

  it("/birthday remove reports when nothing was registered", async () => {
    const handler = createBirthdayRoleHandler({
      config: CONFIG,
      storage: createInMemoryBirthdayStorage(),
    });
    const interaction = makeInteraction("birthday", "user-1", { subcommand: "remove" });

    await birthdayCommand.execute(
      {
        interaction: interaction as never,
        commandName: interaction.commandName,
      },
      { handler },
    );

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "誕生日は登録されていません。",
      ephemeral: true,
    });
  });
});

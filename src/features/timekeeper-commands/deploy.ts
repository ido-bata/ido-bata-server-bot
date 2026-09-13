import type { REST, RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import { REST as RestClass, Routes, SlashCommandBuilder } from "discord.js";

const TIMEKEEPER_COMMAND_DESCRIPTION = "Timekeeper セッションの確認・操作 (moderator role 必須)。";

export type DeployTimekeeperCommandsDeps = {
  token: string;
  clientId: string;
  guildId: string;
  /** Injected REST client. Tests substitute a fake. */
  rest?: Pick<REST, "put">;
  /** Override the payload builder (used by tests). */
  buildPayload?: () => RESTPostAPIChatInputApplicationCommandsJSONBody;
};

export type DeployTimekeeperCommandsResult = { registered: 1 };

export function buildTimekeeperCommandPayload(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("timekeeper")
    .setDescription(TIMEKEEPER_COMMAND_DESCRIPTION)
    .addSubcommand((sub) =>
      sub
        .setName("next")
        .setDescription("次回セッションの JST 開始時刻と相対カウントダウンを表示。"),
    )
    .addSubcommand((sub) =>
      sub.setName("pause").setDescription("現在のセッションを pause (phase-ending-soon を抑止)。"),
    )
    .addSubcommand((sub) =>
      sub.setName("resume").setDescription("pause 状態を解除してセッションを再開。"),
    )
    .addSubcommand((sub) =>
      sub.setName("skip").setDescription("現在のフェーズを即終了し次フェーズへ遷移。"),
    )
    .toJSON();
}

/**
 * PUT the `/timekeeper` slash-command payload (with 4 subcommands) to
 * the guild-scoped route. Idempotent — re-running replaces the previous
 * payload.
 *
 * Throws when any of the credentials are blank, before any REST call is
 * made.
 */
export async function deployTimekeeperCommands(
  deps: DeployTimekeeperCommandsDeps,
): Promise<DeployTimekeeperCommandsResult> {
  if (!deps.token) {
    throw new Error("deployTimekeeperCommands: token is required");
  }
  if (!deps.clientId) {
    throw new Error("deployTimekeeperCommands: clientId is required");
  }
  if (!deps.guildId) {
    throw new Error("deployTimekeeperCommands: guildId is required");
  }

  const payload = (deps.buildPayload ?? buildTimekeeperCommandPayload)();
  const rest = deps.rest ?? new RestClass({ version: "10" }).setToken(deps.token);

  await rest.put(Routes.applicationGuildCommands(deps.clientId, deps.guildId), {
    body: [payload],
  });

  return { registered: 1 };
}

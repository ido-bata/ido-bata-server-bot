import type { REST, RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import { REST as RestClass, Routes, SlashCommandBuilder } from "discord.js";

const TIMEKEEPER_COMMAND_DESCRIPTION = "Timekeeper セッションの確認・操作 (moderator role 必須)。";

export type DeployGuildCommandsDeps = {
  token: string;
  clientId: string;
  guildId: string;
  /**
   * Every guild-scoped slash-command payload the bot wants registered.
   * `Routes.applicationGuildCommands` is a bulk overwrite — passing only
   * this feature's payload here would erase any commands owned by other
   * features, so callers must aggregate definitions from every feature
   * into a single array and call this exactly once.
   */
  payloads: RESTPostAPIChatInputApplicationCommandsJSONBody[];
  /** Injected REST client. Tests substitute a fake. */
  rest?: Pick<REST, "put">;
};

export type DeployGuildCommandsResult = { registered: number };

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
 * PUT every guild-scoped slash-command payload (aggregated across
 * features) to `Routes.applicationGuildCommands` in a single bulk
 * request. Idempotent — re-running replaces the previous set of
 * payloads for the guild.
 *
 * Throws when any of the credentials are blank, before any REST call is
 * made.
 */
export async function deployGuildCommands(
  deps: DeployGuildCommandsDeps,
): Promise<DeployGuildCommandsResult> {
  if (!deps.token) {
    throw new Error("deployGuildCommands: token is required");
  }
  if (!deps.clientId) {
    throw new Error("deployGuildCommands: clientId is required");
  }
  if (!deps.guildId) {
    throw new Error("deployGuildCommands: guildId is required");
  }

  const rest = deps.rest ?? new RestClass({ version: "10" }).setToken(deps.token);

  await rest.put(Routes.applicationGuildCommands(deps.clientId, deps.guildId), {
    body: deps.payloads,
  });

  return { registered: deps.payloads.length };
}

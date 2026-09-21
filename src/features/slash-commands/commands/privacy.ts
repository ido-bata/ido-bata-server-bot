import { randomUUID } from "node:crypto";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import type { ConsentScope } from "../../../consent/scopes.js";
import { DEFAULT_POLICY_VERSION } from "../../../consent/scopes.js";
import type { ConsentService } from "../../../consent/service.js";
import type { ConsentRecord } from "../../../consent/types.js";
import { type ClearReport, clearUserData } from "../../privacy/clear.js";
import {
  type ConsumerBucket,
  type ConsumerEntry,
  getConsumers,
} from "../../privacy/consumer-inventory.js";
import type { SlashCommandDefinition } from "../types.js";

const SUBCOMMAND_STATUS = "status";
const SUBCOMMAND_DELETE = "delete";

const DELETE_CONFIRM_PREFIX = "privacy:delete:confirm:";
const DELETE_CANCEL_PREFIX = "privacy:delete:cancel:";

const SCOPE_LABELS: Record<ConsentScope, string> = {
  "activity-history": "活動履歴 (attendance/reminders/polls)",
  "presence-history": "プレゼンス履歴 (game/Spotify)",
  profile: "プロフィール (誕生日など)",
  "message-history": "メッセージ履歴",
};

export type PrivacyCommandDeps = {
  consentService?: ConsentService;
  // Lets tests substitute a fixed clock / deterministic id source.
  now?: () => Date;
  generateRequestId?: () => string;
};

type StatusSummary = {
  policyVersion: string;
  active: ConsentScope[];
  revoked: ConsentScope[];
  notGranted: ConsentScope[];
  consumers: ConsumerEntry[];
};

type InteractionLike = {
  user: { id: string };
  isRepliable: () => boolean;
  reply: (options: {
    content?: string;
    components?: ActionRowBuilder<ButtonBuilder>[];
    ephemeral?: boolean;
  }) => Promise<unknown>;
  update: (options: {
    content?: string;
    components?: ActionRowBuilder<ButtonBuilder>[];
    ephemeral?: boolean;
  }) => Promise<unknown>;
  followUp: (options: {
    content?: string;
    components?: ActionRowBuilder<ButtonBuilder>[];
    ephemeral?: boolean;
  }) => Promise<unknown>;
};

type StatusInteraction = InteractionLike & {
  options: { getSubcommand: () => string };
};

type DeleteInteraction = StatusInteraction;

export const privacyCommand: SlashCommandDefinition = {
  name: "privacy",
  description: "View or delete the personal data the bot has stored about you.",
  buildPayload: () =>
    new SlashCommandBuilder()
      .setName("privacy")
      .setDescription("View or delete the personal data the bot has stored about you.")
      .addSubcommand((sub) =>
        sub
          .setName(SUBCOMMAND_STATUS)
          .setDescription("Show what data we store and your consent state."),
      )
      .addSubcommand((sub) =>
        sub.setName(SUBCOMMAND_DELETE).setDescription("Delete all data we have stored about you."),
      ) as unknown as SlashCommandBuilder,
  // The dispatcher types `deps` as `unknown` (per-command deps are
  // optional). Privacy narrows it to `PrivacyCommandDeps`; the cast
  // bridges the two without losing runtime safety since the dispatcher
  // forwards whatever was wired at registration time.
  execute: (async (
    { interaction }: { interaction: ChatInputCommandInteraction; commandName: string },
    deps: PrivacyCommandDeps = {},
  ) => {
    const sub = interaction.options.getSubcommand();
    if (sub === SUBCOMMAND_STATUS) {
      await handleStatus(interaction as unknown as StatusInteraction, deps);
      return;
    }
    if (sub === SUBCOMMAND_DELETE) {
      await handleDelete(interaction as unknown as DeleteInteraction, deps);
      return;
    }
    await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true });
  }) as SlashCommandDefinition["execute"],
};

/**
 * Public hook used by the slash-command dispatcher so the `/privacy delete`
 * Confirm/Cancel buttons can resolve back into a clear action. The hook is
 * exposed separately so tests can drive the button path without spinning
 * up a real Discord client.
 */
export async function handlePrivacyButton(
  interaction: InteractionLike & { customId: string },
  deps: PrivacyCommandDeps = {},
): Promise<void> {
  if (interaction.customId.startsWith(DELETE_CONFIRM_PREFIX)) {
    const requestId = interaction.customId.slice(DELETE_CONFIRM_PREFIX.length);
    await runClear(interaction, requestId, deps);
    return;
  }
  if (interaction.customId.startsWith(DELETE_CANCEL_PREFIX)) {
    await interaction.update({
      content: "削除をキャンセルしました。",
      components: [],
      ephemeral: true,
    });
    return;
  }
  // Unknown button — ignore silently.
  void deps;
}

async function handleStatus(
  interaction: StatusInteraction,
  deps: PrivacyCommandDeps,
): Promise<void> {
  const summary = await buildStatusSummary(interaction.user.id, deps.consentService);
  await interaction.reply({
    content: renderStatusMessage(summary),
    ephemeral: true,
  });
}

async function handleDelete(
  interaction: DeleteInteraction,
  deps: PrivacyCommandDeps,
): Promise<void> {
  const requestId = (deps.generateRequestId ?? randomUUID)();
  const confirmId = `${DELETE_CONFIRM_PREFIX}${requestId}`;
  const cancelId = `${DELETE_CANCEL_PREFIX}${requestId}`;
  const components = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(confirmId)
        .setLabel("削除を実行")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(cancelId)
        .setLabel("キャンセル")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  await interaction.reply({
    content: [
      "この操作は取り消せません。続行すると、当ボットのこのサーバーに関する個人データを全消去します。",
      "保存先 (`data/`) の該当エントリおよび暗号化スナップショットを削除します。",
      "",
      "本当に削除しますか?",
    ].join("\n"),
    components,
    ephemeral: true,
  });
}

async function runClear(
  interaction: InteractionLike,
  requestId: string,
  deps: PrivacyCommandDeps,
): Promise<void> {
  // Pass the live `ConsentService` so the clear step also purges
  // `data/consent.json` and emits the `clear` event the snapshot
  // scheduler listens for. Without this the consumer adapters would
  // remove the cached state but the grant records would remain, leaving
  // the user with a phantom authorization.
  const report = await clearUserData(interaction.user.id, {
    consentService: deps.consentService,
  });
  if (report.ok) {
    await interaction.update({
      content: renderClearSuccessMessage(requestId, report),
      components: [],
      ephemeral: true,
    });
    return;
  }
  await interaction.update({
    content: renderClearFailureMessage(requestId, report),
    components: [],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// Status rendering
// ---------------------------------------------------------------------------

async function buildStatusSummary(
  subjectId: string,
  service: ConsentService | undefined,
): Promise<StatusSummary> {
  const consumers: ConsumerEntry[] = [...getConsumers()];
  if (!service) {
    return {
      policyVersion: DEFAULT_POLICY_VERSION,
      active: [],
      revoked: [],
      notGranted: consumers
        .map((consumer) => consumer.scope)
        .filter((scope): scope is ConsentScope => Boolean(scope)),
      consumers,
    };
  }

  const records: ConsentRecord[] = await service.list(subjectId);
  const active = new Set(records.filter((r) => r.revokedAt === null).map((r) => r.scope));
  const revoked = new Set(records.filter((r) => r.revokedAt !== null).map((r) => r.scope));
  const allScopes: ConsentScope[] = [
    "activity-history",
    "presence-history",
    "profile",
    "message-history",
  ];
  const notGranted = allScopes.filter((scope) => !active.has(scope) && !revoked.has(scope));

  return {
    policyVersion: DEFAULT_POLICY_VERSION,
    active: allScopes.filter((s) => active.has(s)),
    revoked: allScopes.filter((s) => revoked.has(s)),
    notGranted,
    consumers,
  };
}

function renderStatusMessage(summary: StatusSummary): string {
  const lines: string[] = [];
  lines.push(`**Privacy status** (policy: \`${summary.policyVersion}\`)`);
  lines.push("");
  lines.push(`- 同意済み (active): ${formatScopes(summary.active)}`);
  lines.push(`- 取消済み (revoked): ${formatScopes(summary.revoked)}`);
  lines.push(`- 未付与 (not-granted): ${formatScopes(summary.notGranted)}`);
  lines.push("");
  lines.push("**保存カテゴリ**");
  for (const bucket of ["consent-gated", "operational", "ephemeral"] as ConsumerBucket[]) {
    const entries = summary.consumers.filter((entry) => entry.bucket === bucket);
    if (entries.length === 0) {
      continue;
    }
    lines.push(`- ${bucket}`);
    for (const entry of entries) {
      const scope = entry.scope ? ` (scope: \`${entry.scope}\`)` : "";
      const file = entry.dataFile ? ` — \`${entry.dataFile}\`` : "";
      lines.push(`  - ${entry.label}${scope}${file}`);
    }
  }
  return lines.join("\n");
}

function formatScopes(scopes: ConsentScope[]): string {
  if (scopes.length === 0) {
    return "_なし_";
  }
  return scopes.map((scope) => `\`${scope}\` (${SCOPE_LABELS[scope]})`).join(", ");
}

// ---------------------------------------------------------------------------
// Delete reply rendering
// ---------------------------------------------------------------------------

function renderClearSuccessMessage(requestId: string, report: ClearReport): string {
  const lines: string[] = [];
  lines.push(`削除が完了しました (request: \`${requestId}\`)。`);
  lines.push("");
  lines.push("- 全 consumer 成功:");
  for (const result of report.results) {
    lines.push(`  - \`${result.consumer}\`: ok`);
  }
  return lines.join("\n");
}

function renderClearFailureMessage(requestId: string, report: ClearReport): string {
  const lines: string[] = [];
  lines.push(
    `**削除は失敗として報告します** (request: \`${requestId}\`)。一部または全部の consumer で問題が発生しました。`,
  );
  lines.push("");
  lines.push("- 結果:");
  for (const result of report.results) {
    const status = result.ok ? "ok" : `failed: ${result.error ?? "unknown error"}`;
    lines.push(`  - \`${result.consumer}\`: ${status}`);
  }
  lines.push("");
  lines.push("再実行するか、オペレーターに連絡してください。");
  return lines.join("\n");
}

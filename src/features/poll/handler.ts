import { randomUUID } from "node:crypto";

import type {
  Client,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { Events, Routes } from "discord.js";
import type { ConsentScope } from "../../consent/scopes.js";
import type { ConsentService } from "../../consent/service.js";
import { childFor, getRootLogger } from "../../lib/logger/index.js";
import { applyVote, buildTallyRows, clearVote } from "./aggregate.js";
import { buildPollEmbed, buildPollMessageComponents, parsePollButtonCustomId } from "./build.js";
import {
  createFilePollStore,
  findPollByMessageId,
  type Poll,
  type PollStateFile,
  type PollStore,
  pollOptionsSchema,
  pollQuestionSchema,
  upsertPoll,
} from "./state.js";

export const POLL_COMMAND_NAME = "poll";
export const POLL_SUBCOMMAND_CREATE = "create";
export const POLL_SUBCOMMAND_CLOSE = "close";

type ReplyOptions = {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  ephemeral?: boolean;
};

// Minimal shape of a poll message that the handler can edit. Decoupling the
// Discord.js `Message` type makes `handleClose` testable without spinning up a
// real REST connection — the production wiring in `registerPollHandlers`
// resolves this via `client.channels.cache.get(...)?.messages.fetch(...)`.
type PollMessageTarget = {
  edit: (options: { embeds?: unknown[]; components?: unknown[] }) => Promise<unknown>;
};

export type PollInteractionLike = {
  isChatInputCommand: () => boolean;
  isButton: () => boolean;
  isRepliable: () => boolean;
  commandName: string;
  options: {
    getSubcommand: () => string;
    getString: (name: string, required?: boolean) => string | null;
  };
  channelId: string;
  channel: {
    send: (options: { embeds: unknown[]; components: unknown[] }) => Promise<{ id: string }>;
  };
  guildId: string | null;
  user: { id: string };
  customId: string;
  // Only present on ButtonInteractions; chat-input commands (e.g. `/poll close`)
  // do not carry a target message, so it is optional here.
  message?: {
    id: string;
    edit: (options: { embeds?: unknown[]; components?: unknown[] }) => Promise<unknown>;
  };
  reply: (options: ReplyOptions) => Promise<unknown>;
  update: (options: ReplyOptions) => Promise<unknown>;
};

/**
 * v0.2.0: poll votes and creator gating share the `activity-history`
 * scope. When the gate is omitted the handler refuses every persistent
 * mutation (fail-closed).
 */
export type PollConsentAuthorization = {
  authorize: (subjectId: string, scope: ConsentScope) => Promise<{ ok: boolean }>;
};

export type PollHandlerDependencies = {
  store?: PollStore;
  now?: () => string;
  generateId?: () => string;
  // Resolves the original Poll message so chat-input commands (which lack
  // `interaction.message`) can still update the embed/components. Returning
  // `null` means the message is unavailable; the close flow degrades to
  // state-only and reports that to the user.
  fetchPollMessage?: (channelId: string, messageId: string) => Promise<PollMessageTarget | null>;
  // v0.2.0 consent gate. When omitted the handler behaves as if every
  // request was denied — see `fail-closed` invariant.
  consent?: PollConsentAuthorization;
};

export type PollHandler = {
  store: PollStore;
  loadState: () => PollStateFile;
  saveState: (state: PollStateFile) => void;
  handleInteraction: (interaction: unknown) => Promise<void>;
};

/**
 * Adapter that lifts a `ConsentService` into the shape the poll handler
 * expects. Used by `index.ts` to wire the v0.2.0 gate into the live handler.
 */
export function toPollConsentAuthorization(service: ConsentService): PollConsentAuthorization {
  return {
    authorize: async (subjectId, scope) => {
      const decision = await service.authorize(subjectId, scope);
      return { ok: decision.ok };
    },
  };
}

export function createPollHandler(deps: PollHandlerDependencies = {}): PollHandler {
  const store = deps.store ?? createFilePollStore("data/polls.json");
  const now = deps.now ?? (() => new Date().toISOString());
  const generateId = deps.generateId ?? (() => randomUUID());
  const fetchPollMessage = deps.fetchPollMessage;
  const consent = deps.consent;

  async function authorizeOrReply(
    interaction: PollInteractionLike,
    subjectId: string,
  ): Promise<boolean> {
    if (!consent) {
      // Fail-closed: refuse persistence when the gate is not wired.
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: "Poll の投票・作成には同意 (activity-history) が必要です。",
          ephemeral: true,
        });
      }
      return false;
    }
    const decision = await consent.authorize(subjectId, "activity-history");
    if (decision.ok) {
      return true;
    }
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: "activity-history の同意がないため、Poll への投票を保存できません。",
        ephemeral: true,
      });
    }
    return false;
  }

  function loadState(): PollStateFile {
    return store.load();
  }

  function saveState(state: PollStateFile): void {
    store.save(state);
  }

  async function handleCreate(interaction: PollInteractionLike): Promise<void> {
    const questionRaw = interaction.options.getString("question", true) ?? "";
    const optionsRaw = interaction.options.getString("options", true) ?? "";

    const parsedQuestion = pollQuestionSchema.safeParse(questionRaw);
    if (!parsedQuestion.success) {
      await interaction.reply({
        content: `質問の形式が不正です: ${parsedQuestion.error.issues[0]?.message ?? "unknown error"}`,
        ephemeral: true,
      });
      return;
    }

    const parsedOptions = pollOptionsSchema.safeParse(parseOptionsString(optionsRaw));
    if (!parsedOptions.success) {
      await interaction.reply({
        content: `選択肢の形式が不正です: ${parsedOptions.error.issues[0]?.message ?? "unknown error"}`,
        ephemeral: true,
      });
      return;
    }

    // v0.2.0: creator must have an active activity-history grant before
    // the poll record (which carries their userId as `creatorId`) is written.
    if (!(await authorizeOrReply(interaction, interaction.user.id))) {
      return;
    }

    const state = loadState();
    const id = generateId();
    const poll: Poll = {
      id,
      guildId: interaction.guildId ?? "",
      channelId: interaction.channelId,
      messageId: "", // filled in after we send the message
      question: parsedQuestion.data,
      options: parsedOptions.data,
      creatorId: interaction.user.id,
      createdAt: now(),
      closed: false,
      votes: {},
    };

    const sent = await interaction.channel.send({
      embeds: [buildPollEmbed(poll)],
      components: buildPollMessageComponents(poll).rows,
    });

    const finalPoll: Poll = { ...poll, messageId: sent.id };
    saveState(upsertPoll(state, finalPoll));

    await interaction.reply({
      content: "Poll を作成しました。",
      ephemeral: true,
    });
  }

  async function handleClose(interaction: PollInteractionLike): Promise<void> {
    const messageId = interaction.options.getString("message_id", true);

    if (!messageId) {
      await interaction.reply({ content: "message_id を指定してください。", ephemeral: true });
      return;
    }

    const state = loadState();
    const poll = findPollByMessageId(state, messageId);

    if (!poll) {
      await interaction.reply({ content: "該当の Poll が見つかりません。", ephemeral: true });
      return;
    }

    if (poll.closed) {
      await interaction.reply({ content: "この Poll はすでに終了しています。", ephemeral: true });
      return;
    }

    if (poll.creatorId !== interaction.user.id) {
      await interaction.reply({
        content: "Poll の作成者のみが終了できます。",
        ephemeral: true,
      });
      return;
    }

    const closed: Poll = { ...poll, closed: true, closedAt: now() };
    saveState(upsertPoll(state, closed));

    // Chat-input commands do not carry `interaction.message`, so resolve the
    // Poll's saved channel/message via the DI seam and edit it directly. If
    // the message is no longer reachable (deleted, missing permission, etc.)
    // we keep the state change and surface a warning to the user.
    const pollMessage = await fetchPollMessage?.(poll.channelId, poll.messageId);
    if (pollMessage) {
      await pollMessage.edit({
        embeds: [buildPollEmbed(closed)],
      });
    }

    await interaction.reply({
      content: pollMessage
        ? "Poll を終了しました。"
        : "Poll を終了しました (元のメッセージを更新できませんでした)。",
      ephemeral: true,
    });
  }

  async function handleVoteButton(
    interaction: PollInteractionLike,
    pollId: string,
    optionIndex: number,
  ): Promise<void> {
    // v0.2.0: voter must have an active activity-history grant before
    // their vote is persisted to `data/polls.json`.
    if (!(await authorizeOrReply(interaction, interaction.user.id))) {
      return;
    }

    const state = loadState();
    const poll = state.polls.find((entry) => entry.id === pollId);

    if (!poll) {
      await interaction.reply({
        content: "この Poll は存在しないか、すでに削除されています。",
        ephemeral: true,
      });
      return;
    }

    if (poll.closed) {
      await interaction.reply({
        content: "この Poll はすでに終了しています。",
        ephemeral: true,
      });
      return;
    }

    let result: ReturnType<typeof applyVote>;
    try {
      result = applyVote(poll, interaction.user.id, optionIndex);
    } catch (error) {
      await interaction.reply({
        content: `無効な選択肢です: ${(error as Error).message}`,
        ephemeral: true,
      });
      return;
    }

    saveState(upsertPoll(state, result.next));

    // ButtonInteraction.message is non-null in real discord.js; the guard
    // defends against malformed mocks and the type-narrowed optional.
    const targetMessage = interaction.message;
    if (!targetMessage) {
      await interaction.reply({
        content: "Poll メッセージを取得できませんでした。",
        ephemeral: true,
      });
      return;
    }

    await targetMessage.edit({
      embeds: [buildPollEmbed(result.next)],
      components: buildPollMessageComponents(result.next).rows,
    });

    const rows = buildTallyRows(result.next);
    const option = rows[optionIndex];
    const response = result.changed
      ? `投票を更新しました: ${option?.label ?? `#${optionIndex + 1}`}`
      : `投票を受け付けました: ${option?.label ?? `#${optionIndex + 1}`}`;

    await interaction.reply({ content: response, ephemeral: true });
  }

  async function handleClearButton(
    interaction: PollInteractionLike,
    pollId: string,
  ): Promise<void> {
    // v0.2.0: clearing a vote still mutates the persisted record, so the
    // activity-history gate applies symmetrically to add and clear.
    if (!(await authorizeOrReply(interaction, interaction.user.id))) {
      return;
    }

    const state = loadState();
    const poll = state.polls.find((entry) => entry.id === pollId);

    if (!poll) {
      await interaction.reply({
        content: "この Poll は存在しないか、すでに削除されています。",
        ephemeral: true,
      });
      return;
    }

    const result = clearVote(poll, interaction.user.id);
    if (!result.hadVote) {
      await interaction.reply({
        content: "投票履歴はありません。",
        ephemeral: true,
      });
      return;
    }

    saveState(upsertPoll(state, result.next));

    // ButtonInteraction.message is non-null in real discord.js; the guard
    // defends against malformed mocks and the type-narrowed optional.
    const targetMessage = interaction.message;
    if (!targetMessage) {
      await interaction.reply({
        content: "Poll メッセージを取得できませんでした。",
        ephemeral: true,
      });
      return;
    }

    await targetMessage.edit({
      embeds: [buildPollEmbed(result.next)],
      components: buildPollMessageComponents(result.next).rows,
    });

    await interaction.reply({ content: "投票を取り消しました。", ephemeral: true });
  }

  async function handleInteraction(raw: unknown): Promise<void> {
    const interaction = raw as PollInteractionLike;

    if (interaction.isButton()) {
      const parsed = parsePollButtonCustomId(interaction.customId);
      if (!parsed) {
        return;
      }

      if (parsed.kind === "vote" && typeof parsed.optionIndex === "number") {
        await handleVoteButton(interaction, parsed.pollId, parsed.optionIndex);
        return;
      }

      if (parsed.kind === "clear") {
        await handleClearButton(interaction, parsed.pollId);
        return;
      }

      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName !== POLL_COMMAND_NAME) {
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === POLL_SUBCOMMAND_CREATE) {
      await handleCreate(interaction);
      return;
    }

    if (subcommand === POLL_SUBCOMMAND_CLOSE) {
      await handleClose(interaction);
      return;
    }
  }

  return {
    store,
    loadState,
    saveState,
    handleInteraction,
  };
}

export type DeployCommandsDependencies = {
  rest?: Pick<typeof Client.prototype.rest, "put">;
  clientId?: string;
  guildId?: string;
};

export async function deployPollCommands(
  client: Client,
  deps: DeployCommandsDependencies = {},
): Promise<{ registered: number }> {
  const clientId = deps.clientId ?? client.user?.id ?? "";
  const guildId = deps.guildId ?? client.guilds.cache.first()?.id ?? "";

  if (!clientId) {
    throw new Error("deployPollCommands: clientId is required");
  }

  if (!guildId) {
    throw new Error("deployPollCommands: guildId is required");
  }

  const rest = deps.rest ?? client.rest;
  const payload = buildPollCommandPayload();

  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: payload });

  return { registered: payload.length };
}

// Internal-only: shapes the JSON body for the REST registration call. Kept as
// a separate function so the payload is easy to unit-test. Re-exported as a
// building block for the aggregated `deployGuildCommands` call in
// `src/index.ts` so per-feature deployers do not independently PUT to
// `Routes.applicationGuildCommands` (which would race and overwrite each
// other — see PR review VJn3).
export function buildPollCommandPayload(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return [
    {
      name: POLL_COMMAND_NAME,
      description: "選択肢付き Poll を作成 / 終了します。",
      options: [
        {
          type: 1,
          name: POLL_SUBCOMMAND_CREATE,
          description: "新しい Poll を作成します。",
          options: [
            {
              type: 3,
              name: "question",
              description: "質問内容 (200 文字以内)。",
              required: true,
              min_length: 1,
              max_length: 200,
            },
            {
              type: 3,
              name: "options",
              description: "選択肢を改行区切りで 2-10 個 (各 80 文字以内、重複不可)。",
              required: true,
              min_length: 1,
              max_length: 1000,
            },
          ],
        },
        {
          type: 1,
          name: POLL_SUBCOMMAND_CLOSE,
          description: "自分が作成した Poll を終了します。",
          options: [
            {
              type: 3,
              name: "message_id",
              description: "終了する Poll メッセージの ID。",
              required: true,
              min_length: 1,
              max_length: 32,
            },
          ],
        },
      ],
    },
  ];
}

export function registerPollHandlers(
  client: Client,
  deps: PollHandlerDependencies = {},
): PollHandler {
  const fetchPollMessage =
    deps.fetchPollMessage ??
    (async (channelId: string, messageId: string): Promise<PollMessageTarget | null> => {
      try {
        const channel = client.channels.cache.get(channelId);
        if (!channel) {
          return null;
        }
        // Only text-based channels expose `messages.fetch`. We narrow via the
        // duck-typed method check rather than `isTextBased()` so this still
        // type-checks when the @types/discord.js narrowing rules change.
        if (typeof (channel as { messages?: { fetch?: unknown } }).messages?.fetch !== "function") {
          return null;
        }
        const fetched = await (
          channel as { messages: { fetch: (id: string) => Promise<unknown> } }
        ).messages.fetch(messageId);
        if (!fetched) {
          return null;
        }
        return {
          edit: (options) =>
            (fetched as { edit: (opts: unknown) => Promise<unknown> }).edit(options),
        };
      } catch (error) {
        const pollLogger = childFor(getRootLogger(), "poll");
        pollLogger.warn(
          { channelId, messageId, reason: (error as Error).message },
          "failed to resolve poll message",
        );
        return null;
      }
    });

  const handler = createPollHandler({ ...deps, fetchPollMessage });

  client.on(Events.InteractionCreate, (interaction) => {
    void handler.handleInteraction(interaction).catch((error: unknown) => {
      childFor(getRootLogger(), "poll").error({ err: error }, "interaction handler failed");
    });
  });

  return handler;
}

// `parseOptionsString` splits on newlines or pipes, the two formats humans
// usually paste into a slash command option string.
export function parseOptionsString(raw: string): string[] {
  return raw
    .split(/\r?\n|\|/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

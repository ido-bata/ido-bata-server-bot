import { buildTallyRows } from "./aggregate.js";
import type { Poll } from "./state.js";

// Discord allows at most 5 buttons per ActionRow and at most 5 ActionRows per
// message, so 10 options fits naturally as two rows of five.

export function buildPollButtonCustomId(pollId: string, optionIndex: number): string {
  return `poll:${pollId}:vote:${optionIndex}`;
}

export function buildPollClearCustomId(pollId: string): string {
  return `poll:${pollId}:clear`;
}

export function parsePollButtonCustomId(
  customId: string,
): { pollId: string; kind: "vote" | "clear"; optionIndex?: number } | null {
  const parts = customId.split(":");
  // Format: poll:<pollId>:vote:<optionIndex> | poll:<pollId>:clear
  if (parts[0] !== "poll" || parts.length < 3) {
    return null;
  }

  const [, pollId, kindToken, value] = parts;

  if (!pollId) {
    return null;
  }

  if (kindToken === "clear") {
    return { pollId, kind: "clear" };
  }

  if (kindToken === "vote" && value !== undefined) {
    const optionIndex = Number.parseInt(value, 10);
    if (!Number.isInteger(optionIndex)) {
      return null;
    }
    return { pollId, kind: "vote", optionIndex };
  }

  return null;
}

export function buildPollMessageComponents(poll: Poll): {
  rows: Array<{
    type: 1;
    components: Array<{
      type: 2;
      style: 1 | 2;
      label: string;
      custom_id: string;
    }>;
  }>;
} {
  const rows: ReturnType<typeof buildPollMessageComponents>["rows"] = [];

  for (const [, chunk] of chunkArray(poll.options.entries(), 5).entries()) {
    const components: ReturnType<typeof buildPollMessageComponents>["rows"][number]["components"] =
      [];

    for (const [optionIndex, label] of chunk) {
      components.push({
        type: 2,
        style: 2,
        label: truncateLabel(label, 80),
        custom_id: buildPollButtonCustomId(poll.id, optionIndex),
      });
    }

    rows.push({ type: 1, components });
  }

  // Always offer a "clear my vote" affordance as its own row.
  rows.push({
    type: 1,
    components: [
      {
        type: 2,
        style: 1,
        label: "投票を取り消す",
        custom_id: buildPollClearCustomId(poll.id),
      },
    ],
  });

  return { rows };
}

export type PollEmbedPayload = {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
};

export function buildPollEmbed(poll: Poll): PollEmbedPayload {
  const rows = buildTallyRows(poll);
  const total = rows.reduce((sum, row) => sum + row.count, 0);

  const lines = rows.map((row) => {
    const bar = renderBar(row.percentage);
    return `\`${row.index + 1}\` ${row.label} — **${row.count}票** (${row.percentage.toFixed(1)}%) ${bar}`;
  });

  const status = poll.closed
    ? `終了 (${poll.closedAt ?? "—"})`
    : total === 0
      ? "未投票"
      : `投票中 (${total}票)`;

  const description = [poll.question, "", ...lines, "", `> ${status}`].join("\n");

  return {
    title: poll.closed ? "📊 Poll (closed)" : "📊 Poll",
    description,
    color: poll.closed ? 0x99aab5 : 0x5865f2,
    fields: [
      {
        name: "選択肢",
        value: poll.options.map((label, index) => `\`${index + 1}\` ${label}`).join("\n"),
        inline: false,
      },
    ],
    footer: { text: `poll id: ${poll.id}` },
  };
}

function chunkArray<T>(iterable: Iterable<T>, size: number): T[][] {
  const chunks: T[][] = [];
  let buffer: T[] = [];

  for (const value of iterable) {
    buffer.push(value);
    if (buffer.length === size) {
      chunks.push(buffer);
      buffer = [];
    }
  }

  if (buffer.length > 0) {
    chunks.push(buffer);
  }

  return chunks;
}

function renderBar(percentage: number): string {
  // 10 blocks total. Always show at least an empty bar so 0% is visible.
  const filled = Math.max(0, Math.min(10, Math.round(percentage / 10)));
  return "▓".repeat(filled) + "░".repeat(10 - filled);
}

function truncateLabel(label: string, max: number): string {
  if (label.length <= max) {
    return label;
  }
  return `${label.slice(0, max - 1)}…`;
}

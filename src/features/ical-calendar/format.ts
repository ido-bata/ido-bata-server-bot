import type { CalendarEvent } from "./types.js";

const JST_OFFSET_MS = 9 * 60 * 60_000;

export function listEventsMessage(
  events: CalendarEvent[],
  sourceNames: Map<string, string>,
  now: Date = new Date(),
): string {
  if (events.length === 0) {
    return "予定されているイベントはありません。";
  }

  const lines: string[] = ["## 直近の予定"];
  for (const event of events) {
    lines.push(formatEventLine(event, sourceNames, now));
  }
  return lines.join("\n");
}

export function showEventMessage(event: CalendarEvent, sourceName: string): string {
  const lines = [
    `## ${event.summary}`,
    `カレンダー: ${sourceName}`,
    `開始: ${formatJstDateTime(event.startAt)}${event.isAllDay ? " (終日)" : ""}`,
  ];
  if (event.endAt) {
    lines.push(`終了: ${formatJstDateTime(event.endAt)}`);
  }
  if (event.location) {
    lines.push(`場所: ${event.location}`);
  }
  if (event.description) {
    lines.push(`詳細: ${truncate(event.description, 400)}`);
  }
  return lines.join("\n");
}

export function formatEventLine(
  event: CalendarEvent,
  sourceNames: Map<string, string>,
  now: Date,
): string {
  const dateLabel = formatJstDate(event.startAt);
  const timeLabel = event.isAllDay ? "終日" : formatJstTime(event.startAt);
  const endLabel = event.endAt && !event.isAllDay ? `〜${formatJstTime(event.endAt)}` : "";
  const dayOffset = daysFromNow(event.startAt, now);
  const marker = dayOffset === 0 ? "[本日]" : `[${dayOffset}日後]`;
  const sourceLabel = sourceNames.get(event.sourceId) ?? event.sourceId;
  return `- ${marker} ${dateLabel} ${timeLabel}${endLabel ? ` ${endLabel}` : ""} — ${event.summary} (${sourceLabel})`;
}

export function formatJstDateTime(date: Date): string {
  return `${formatJstDate(date)} ${formatJstTime(date)}`;
}

export function formatJstDate(date: Date): string {
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  const yyyy = jst.getUTCFullYear();
  const mm = (jst.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = jst.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function formatJstTime(date: Date): string {
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  const hh = jst.getUTCHours().toString().padStart(2, "0");
  const mm = jst.getUTCMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

function daysFromNow(target: Date, now: Date): number {
  const startOfNowJst = startOfDayJst(now);
  const startOfTargetJst = startOfDayJst(target);
  return Math.round((startOfTargetJst - startOfNowJst) / (24 * 60 * 60_000));
}

function startOfDayJst(date: Date): number {
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  jst.setUTCHours(0, 0, 0, 0);
  return jst.getTime() - JST_OFFSET_MS;
}

function truncate(text: string, length: number): string {
  if (text.length <= length) {
    return text;
  }
  return `${text.slice(0, length)}…`;
}

export function sortByStart(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((left, right) => left.startAt.getTime() - right.startAt.getTime());
}

export function filterUpcoming(
  events: CalendarEvent[],
  options: { now?: Date; sourceIds?: string[] | null; until: Date },
): CalendarEvent[] {
  const now = options.now ?? new Date();
  return events.filter((event) => {
    if (
      event.endAt ? event.endAt.getTime() < now.getTime() : event.startAt.getTime() < now.getTime()
    ) {
      return false;
    }
    if (event.startAt.getTime() > options.until.getTime()) {
      return false;
    }
    if (options.sourceIds && options.sourceIds.length > 0) {
      if (!options.sourceIds.includes(event.sourceId)) {
        return false;
      }
    }
    return true;
  });
}

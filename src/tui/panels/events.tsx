import { Box, Text } from "ink";
import type { FC } from "react";

import type { NormalizedLogEvent } from "../../lib/logger/index.js";

export type EventsPanelProps = {
  events: ReadonlyArray<NormalizedLogEvent>;
  /** Maximum number of events to render. Defaults to 12. */
  max?: number;
};

const PINO_LEVELS: Record<number, { label: string; color: string }> = {
  10: { label: "trace", color: "gray" },
  20: { label: "debug", color: "gray" },
  30: { label: "info", color: "cyan" },
  40: { label: "warn", color: "yellow" },
  50: { label: "error", color: "red" },
  60: { label: "fatal", color: "red" },
};

function levelLabel(level: number | undefined): string {
  if (typeof level !== "number") {
    return "?";
  }
  return PINO_LEVELS[level]?.label ?? `lvl${level}`;
}

function levelColor(level: number | undefined): string {
  if (typeof level !== "number") {
    return "gray";
  }
  return PINO_LEVELS[level]?.color ?? "gray";
}

function formatTime(time: number | undefined): string {
  if (typeof time !== "number") {
    return "--:--:--";
  }
  const date = new Date(time);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatComponent(component: string | undefined): string {
  if (!component) {
    return "-".repeat(16);
  }
  return component.padEnd(16, " ").slice(0, 16);
}

function formatMessage(message: string | undefined): string {
  if (typeof message !== "string" || message.length === 0) {
    return "(no message)";
  }
  // Keep the panel compact; long lines are truncated.
  return message.length > 80 ? `${message.slice(0, 77)}...` : message;
}

export const EventsPanel: FC<EventsPanelProps> = ({ events, max = 12 }) => {
  const tail = events.slice(-max);
  if (tail.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>(no log events yet)</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {tail.map((event) => (
        <Text key={`${event.time ?? Math.random()}-${event.message ?? ""}`}>
          <Text dimColor>{formatTime(event.time)} </Text>
          <Text color={levelColor(event.level)}>{levelLabel(event.level).padEnd(5, " ")}</Text>
          <Text dimColor> {formatComponent(event.component)}</Text>
          <Text>{formatMessage(event.message)}</Text>
        </Text>
      ))}
    </Box>
  );
};

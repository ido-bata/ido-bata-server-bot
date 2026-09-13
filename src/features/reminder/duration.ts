import { MIN_DURATION_MS } from "./config.js";

const UNIT_TO_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

const UNIT_LABELS: Record<string, string> = {
  s: "秒",
  m: "分",
  h: "時間",
  d: "日",
};

export type ParseDurationResult =
  | { ok: true; durationMs: number; normalized: string }
  | { ok: false; error: string };

/**
 * Parse a duration literal like `30m`, `2h15m`, `1d`. Unit tokens are
 * concatenated with no delimiter so `/remind me 1h30m "..."` works.
 */
export function parseDuration(input: string): ParseDurationResult {
  if (typeof input !== "string") {
    return { ok: false, error: "duration must be a string" };
  }

  const trimmed = input.trim().toLowerCase();

  if (trimmed.length === 0) {
    return { ok: false, error: "duration is required" };
  }

  // Greedy match: number followed by a unit character (s/m/h/d). Allows
  // chains like `1h30m` because we accumulate the totals.
  const tokenizer = /(\d+)([smhd])/g;
  let total = 0;
  const normalizedParts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenizer.exec(trimmed)) !== null) {
    if (match.index !== lastIndex) {
      return {
        ok: false,
        error: "duration must look like <number><unit> tokens (e.g. 30m, 1h30m)",
      };
    }

    const value = Number.parseInt(match[1]!, 10);
    const unit = match[2]!;
    const unitMs = UNIT_TO_MS[unit];

    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, error: "duration values must be positive integers" };
    }

    total += value * unitMs;
    normalizedParts.push(`${value}${unit}`);
    lastIndex = tokenizer.lastIndex;
  }

  if (total === 0) {
    return {
      ok: false,
      error: "duration must include at least one unit (s / m / h / d)",
    };
  }

  if (lastIndex !== trimmed.length) {
    return {
      ok: false,
      error: "duration has unsupported characters; allowed: digits and s/m/h/d",
    };
  }

  if (total < MIN_DURATION_MS) {
    return { ok: false, error: "duration must be at least 1 second" };
  }

  return { ok: true, durationMs: total, normalized: normalizedParts.join("") };
}

/**
 * Render a millisecond duration as a human-readable label, e.g. `1h30m` for
 * 90 minutes. Returns the original numeric input when no combination of the
 * supported units divides evenly, to avoid lossy rounding.
 */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "0s";
  }

  let remaining = Math.floor(durationMs / 1_000) * 1_000;
  const parts: string[] = [];

  for (const unit of ["d", "h", "m", "s"] as const) {
    const unitMs = UNIT_TO_MS[unit];
    const count = Math.floor(remaining / unitMs);
    if (count > 0) {
      parts.push(`${count}${unit}`);
      remaining -= count * unitMs;
    }
  }

  // Fallback for values that don't decompose cleanly.
  return parts.length === 0 ? `${Math.round(durationMs / 1_000)}s` : parts.join("");
}

/**
 * Convenience used by the slash command to format a friendly label that mixes
 * units with Japanese time labels so the confirmation reply reads naturally.
 */
export function formatDurationVerbose(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "0秒";
  }

  let remaining = Math.floor(durationMs / 1_000) * 1_000;
  const parts: string[] = [];

  for (const unit of ["d", "h", "m", "s"] as const) {
    const unitMs = UNIT_TO_MS[unit];
    const count = Math.floor(remaining / unitMs);
    if (count > 0) {
      parts.push(`${count}${UNIT_LABELS[unit]}`);
      remaining -= count * unitMs;
    }
  }

  return parts.length === 0 ? `${Math.round(durationMs / 1_000)}秒` : parts.join("");
}

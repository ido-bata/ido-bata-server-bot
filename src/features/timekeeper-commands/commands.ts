import { type TimekeeperConfig, timekeeperConfig } from "../timekeeper/config.js";
import { getNextDailyStartAt } from "../timekeeper/schedule.js";
import {
  getTimekeeperSessionSnapshot,
  isTimekeeperSessionActive,
  pauseTimekeeperSession,
  requestTimekeeperSkip,
  resumeTimekeeperSession,
  type TimekeeperSessionSnapshot,
} from "../timekeeper/service.js";

/**
 * Result of a `/timekeeper` subcommand. `ephemeral` is always true at the
 * Discord layer; we still mirror it on the result so test assertions can
 * spot a regression where someone flips it to a public reply.
 */
export type TimekeeperCommandResult = {
  content: string;
  ephemeral: true;
};

export type TimekeeperCommandsDependencies = {
  /**
   * The Discord role ID that may execute moderator-only subcommands
   * (`pause` / `resume` / `skip`). An empty string disables role-based
   * gating and falls back to a permission-bit check in the Discord
   * handler (out of scope for the pure command functions).
   */
  moderatorRoleId: string;
  /** Whether `interactorRoleIds` contains the moderator role. Injected. */
  hasModeratorRole: boolean;
  /** Snapshot of the timekeeper runtime. Defaults to the live module state. */
  getSnapshot?: () => TimekeeperSessionSnapshot;
  /** `Date.now()` replacement for deterministic /next replies. */
  now?: () => Date;
  /** Daily-start resolver override. Defaults to `getNextDailyStartAt`. */
  computeNextStartAt?: (now: Date) => Date;
  /** Timekeeper config; defaults to the imported `timekeeperConfig`. */
  timekeeperConfig?: TimekeeperConfig;
};

// Default to the imported config so callers don't have to pass it.
const defaultTimekeeperConfig: TimekeeperConfig = timekeeperConfig;

/**
 * Shared state that all four slash commands read from. Returning a small
 * record from one shared dependency keeps the unit-test surface narrow.
 */
function readSnapshot(deps: TimekeeperCommandsDependencies): TimekeeperSessionSnapshot {
  return (deps.getSnapshot ?? getTimekeeperSessionSnapshot)();
}

/**
 * Guard for moderator-only subcommands. `/timekeeper next` is read-only
 * and intentionally NOT gated so moderators can still share what the
 * bot is going to do.
 */
function ensureModerator(deps: TimekeeperCommandsDependencies): void {
  if (deps.hasModeratorRole) {
    return;
  }
  throw new TimekeeperCommandError("permission", "このコマンドはモデレーターのみ実行できます。");
}

export class TimekeeperCommandError extends Error {
  constructor(
    public readonly code: "no-active-session" | "not-paused" | "already-paused" | "permission",
    message: string,
  ) {
    super(message);
    this.name = "TimekeeperCommandError";
  }
}

/**
 * `/timekeeper next` — reports the next scheduled session's JST start
 * time and a relative countdown. If a session is currently active,
 * reports the in-flight session and the current phase that is firing.
 *
 * Read-only by design — does not require moderator role.
 */
export function timekeeperNext(deps: TimekeeperCommandsDependencies): TimekeeperCommandResult {
  const snapshot = readSnapshot(deps);
  const now = (deps.now ?? (() => new Date()))();

  if (isTimekeeperSessionActive()) {
    return {
      ephemeral: true,
      content: `次のセッションは進行中です (session id: ${snapshot.activeSessionId ?? "unknown"})。`,
    };
  }

  const config = deps.timekeeperConfig ?? defaultTimekeeperConfig;
  const compute = deps.computeNextStartAt ?? ((value: Date) => getNextDailyStartAt(value));
  const nextStartAt = compute(now);
  const diffMs = nextStartAt.getTime() - now.getTime();
  const countdown = formatCountdown(diffMs);
  const jstLabel = formatJst(nextStartAt);

  const phaseCount = config.phases.length;
  const phaseSuffix = `\n予定フェーズ数: ${phaseCount} (合計 ${totalDurationMinutes(config)}分)`;

  return {
    ephemeral: true,
    content: `次のセッション開始: ${jstLabel} (あと ${countdown})${phaseSuffix}`,
  };
}

/**
 * `/timekeeper pause` — pause the active session's phase-ending-soon
 * transitions. Returns an error if no session is active.
 */
export function timekeeperPause(deps: TimekeeperCommandsDependencies): TimekeeperCommandResult {
  ensureModerator(deps);
  const snapshot = readSnapshot(deps);
  if (!snapshot.activeSessionId) {
    throw new TimekeeperCommandError(
      "no-active-session",
      "進行中のセッションがないため pause できません。",
    );
  }
  if (snapshot.paused) {
    throw new TimekeeperCommandError("already-paused", "セッションはすでに pause されています。");
  }
  const applied = pauseTimekeeperSession();
  if (!applied) {
    throw new TimekeeperCommandError(
      "no-active-session",
      "進行中のセッションがないため pause できませんでした。",
    );
  }
  return { ephemeral: true, content: "セッションを pause しました。" };
}

/**
 * `/timekeeper resume` — clear the pause state on the active session.
 */
export function timekeeperResume(deps: TimekeeperCommandsDependencies): TimekeeperCommandResult {
  ensureModerator(deps);
  const snapshot = readSnapshot(deps);
  if (!snapshot.activeSessionId) {
    throw new TimekeeperCommandError(
      "no-active-session",
      "進行中のセッションがないため resume できません。",
    );
  }
  if (!snapshot.paused) {
    throw new TimekeeperCommandError("not-paused", "セッションは pause されていません。");
  }
  const applied = resumeTimekeeperSession();
  if (!applied) {
    throw new TimekeeperCommandError("not-paused", "セッションを resume できませんでした。");
  }
  return { ephemeral: true, content: "セッションを resume しました。" };
}

/**
 * `/timekeeper skip` — request the active session to interrupt its
 * current wait and proceed to the next timeline event. Returns an
 * error if no session is active. A skip that lands while the loop is
 * not awaiting has no observable effect other than clearing the flag.
 */
export function timekeeperSkip(deps: TimekeeperCommandsDependencies): TimekeeperCommandResult {
  ensureModerator(deps);
  const snapshot = readSnapshot(deps);
  if (!snapshot.activeSessionId) {
    throw new TimekeeperCommandError(
      "no-active-session",
      "進行中のセッションがないため skip できません。",
    );
  }
  const applied = requestTimekeeperSkip();
  if (!applied) {
    throw new TimekeeperCommandError(
      "no-active-session",
      "進行中のセッションがないため skip できませんでした。",
    );
  }
  return { ephemeral: true, content: "現在のフェーズを skip します。" };
}

/**
 * Helper used by tests and the Discord handler: returns the `next` /
 * `pause` / `resume` / `skip` subcommand name → dispatch function. Order
 * matches the `subcommand` field of a Discord `ChatInputCommandInteraction`.
 */
export const timekeeperSubcommandHandlers = {
  next: timekeeperNext,
  pause: timekeeperPause,
  resume: timekeeperResume,
  skip: timekeeperSkip,
} as const;

export type TimekeeperSubcommandName = keyof typeof timekeeperSubcommandHandlers;

function formatJst(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatCountdown(diffMs: number): string {
  if (diffMs <= 60_000) {
    return "まもなく開始";
  }
  const totalMinutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours}時間${minutes}分`;
  }
  return `${minutes}分`;
}

function totalDurationMinutes(config: TimekeeperConfig): number {
  return config.phases.reduce((total, phase) => total + phase.durationMinutes, 0);
}

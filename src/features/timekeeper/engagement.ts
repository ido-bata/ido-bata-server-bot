import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ConsentEvent } from "../../consent/types.js";
import type { TimekeeperEventKind } from "./timeline.js";
import { fetchRandomWikipediaTopic, type WikipediaTopic } from "./wikipedia.js";

export type TimekeeperSessionStatus = "completed" | "cancelled" | "interrupted";

export type TimekeeperSessionRecord = {
  endedAt: string;
  id: string;
  reason?: string;
  startedAt: string;
  status: TimekeeperSessionStatus;
};

export type TimekeeperSessionEngagement = {
  attendanceDatesByUserId: Map<string, Set<string>>;
  checkInsByUserId: Map<string, Set<number>>;
  id: string;
};

type PersistedAttendance = Record<string, string[]>;
type PersistedSessionLog = TimekeeperSessionRecord[];

function getHistoryPath(): string {
  return join(process.cwd(), "data", "timekeeper-history.json");
}

function getSessionLogPath(): string {
  return join(process.cwd(), "data", "timekeeper-sessions.json");
}

type FortuneDependencies = {
  fetchRandomTopic?: () => Promise<WikipediaTopic>;
};

export function createSessionEngagement(id: string): TimekeeperSessionEngagement {
  return {
    attendanceDatesByUserId: loadAttendanceHistory(),
    id,
    checkInsByUserId: new Map(),
  };
}

export function buildCheckInCustomId(sessionId: string, order: number): string {
  return `timekeeper:check-in:${sessionId}:${order}`;
}

export function parseCheckInCustomId(
  customId: string,
): { order: number; sessionId: string } | null {
  const match = /^timekeeper:check-in:(.+):(\d+)$/.exec(customId);
  if (!match) {
    return null;
  }

  return {
    sessionId: match[1]!,
    order: Number.parseInt(match[2]!, 10),
  };
}

/**
 * In-memory check-in collector. **Never gates on consent** — per the v0.2.0
 * non-consent path (docs/privacy.md § 6) the session check-in itself must
 * stay usable so the timekeeper remains functional when a user has not
 * granted consent. The persistence path (`persistSessionAttendance`) is
 * what enforces the gate.
 */
export function recordCheckIn(
  session: TimekeeperSessionEngagement,
  userId: string,
  order: number,
): boolean {
  const existing = session.checkInsByUserId.get(userId) ?? new Set<number>();
  const beforeSize = existing.size;
  existing.add(order);
  session.checkInsByUserId.set(userId, existing);
  return existing.size !== beforeSize;
}

/**
 * Add a per-user attendance date to the in-memory map. The actual write to
 * `data/timekeeper-history.json` happens in `persistSessionAttendance` —
 * this function only mutates the session object and never touches disk.
 *
 * Consent-gated via the current `PersistenceAuthorization`. A revoke event
 * short-circuits the gate so future writes for that user are skipped even
 * if the authorization store lags behind.
 */
export async function recordAttendance(
  session: TimekeeperSessionEngagement,
  userId: string,
  date: string,
): Promise<void> {
  if (revokedUsers.has(userId)) {
    return;
  }
  const auth = currentAuthorization;
  if (!auth) {
    // Fail-closed: with no auth wired, no user gets persisted. The bot
    // must wire `attachPersistenceAuthorization` at startup to enable
    // any persistence; see `registerTimekeeper` in service.ts.
    return;
  }
  const decision = await auth.authorize(userId, "activity-history");
  if (!decision.ok) {
    return;
  }
  const existing = session.attendanceDatesByUserId.get(userId) ?? new Set<string>();
  existing.add(date);
  session.attendanceDatesByUserId.set(userId, existing);
}

export function getSessionCheckInCount(
  session: TimekeeperSessionEngagement,
  order: number,
): number {
  return [...session.checkInsByUserId.values()].filter((orders) => orders.has(order)).length;
}

export function buildCheckInLabel(kind: TimekeeperEventKind): string {
  return kind === "break-start" ? "休憩に入る" : "フェーズを確認";
}

export async function buildFortuneSummary(
  session: TimekeeperSessionEngagement,
  dependencies: FortuneDependencies = {},
  random: () => number = Math.random,
): Promise<string[] | null> {
  const entries = await Promise.all(
    [...session.checkInsByUserId.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "ja"))
      .map(async ([userId, orders]) => {
        const topic = await (dependencies.fetchRandomTopic?.() ?? fetchRandomWikipediaTopic());
        const fortune = pickFortuneText(orders.size, random);
        const streakDays = countStreakDays(
          session.attendanceDatesByUserId.get(userId) ?? new Set<string>(),
        );
        return [
          "## 今日の締めおみくじ",
          `<@${userId}> ${fortune} (参加: ${orders.size}フェーズ / 連続: ${streakDays}日)`,
          `ランダムWikipedia占い: ${topic.url}`,
        ].join("\n");
      }),
  );

  if (entries.length === 0) {
    return null;
  }

  return entries;
}

/**
 * Persist the session attendance map to `data/timekeeper-history.json`.
 *
 * Consent-gated: each user in the session map is checked against the
 * currently wired `PersistenceAuthorization`. Users without consent — or
 * users who have been revoked since the last reconcile — are filtered out
 * before any JSON write happens.
 */
export async function persistSessionAttendance(
  session: TimekeeperSessionEngagement,
  date: string,
): Promise<void> {
  const auth = currentAuthorization;
  if (!auth) {
    // Fail-closed: no auth wired means no persistence, regardless of who
    // checked in. This is the documented non-consent path.
    return;
  }

  for (const userId of session.checkInsByUserId.keys()) {
    if (revokedUsers.has(userId)) {
      continue;
    }
    const decision = await auth.authorize(userId, "activity-history");
    if (!decision.ok) {
      continue;
    }
    const existing = session.attendanceDatesByUserId.get(userId) ?? new Set<string>();
    existing.add(date);
    session.attendanceDatesByUserId.set(userId, existing);
  }

  const serialized: PersistedAttendance = {};
  for (const [userId, dates] of session.attendanceDatesByUserId.entries()) {
    serialized[userId] = [...dates].sort();
  }

  const historyPath = getHistoryPath();
  mkdirSync(dirname(historyPath), { recursive: true });
  writeFileSync(historyPath, JSON.stringify(serialized, null, 2), "utf8");
}

/**
 * Mark an in-progress session as interrupted (e.g. bot shutdown). Persists
 * any check-ins / attendance already collected so the data is not lost, then
 * appends a session-status entry to the session log.
 *
 * The session status log is the durable record of which sessions completed
 * normally vs were cancelled or interrupted by a graceful shutdown.
 */
export async function markSessionInterrupted(
  session: TimekeeperSessionEngagement,
  options: { reason?: string; status?: TimekeeperSessionStatus } = {},
): Promise<void> {
  const status: TimekeeperSessionStatus = options.status ?? "interrupted";
  const date = formatSessionDateFromId(session.id);

  if (session.checkInsByUserId.size > 0) {
    await persistSessionAttendance(session, date);
  }

  const log = loadSessionLog();
  log.push({
    endedAt: new Date().toISOString(),
    id: session.id,
    reason: options.reason,
    startedAt: session.id,
    status,
  });

  const logPath = getSessionLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, JSON.stringify(log, null, 2), "utf8");
}

export function loadSessionLog(): TimekeeperSessionRecord[] {
  const logPath = getSessionLogPath();
  if (!existsSync(logPath)) {
    return [];
  }

  const raw = readFileSync(logPath, "utf8");
  try {
    const parsed = JSON.parse(raw) as PersistedSessionLog;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatSessionDateFromId(id: string): string {
  const parsed = new Date(id);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(parsed);
}

function loadAttendanceHistory(): Map<string, Set<string>> {
  const historyPath = getHistoryPath();
  if (!existsSync(historyPath)) {
    return new Map();
  }

  const raw = readFileSync(historyPath, "utf8");
  const parsed = JSON.parse(raw) as PersistedAttendance;
  return new Map(Object.entries(parsed).map(([userId, dates]) => [userId, new Set(dates)]));
}

function countStreakDays(dates: Set<string>): number {
  const sorted = [...dates].sort();
  if (sorted.length === 0) {
    return 0;
  }

  let streak = 1;
  for (let index = sorted.length - 1; index > 0; index -= 1) {
    const current = new Date(`${sorted[index]}T00:00:00+09:00`);
    const previous = new Date(`${sorted[index - 1]}T00:00:00+09:00`);
    if (current.getTime() - previous.getTime() === 86_400_000) {
      streak += 1;
      continue;
    }
    break;
  }

  return streak;
}

// ---------------------------------------------------------------------------
// PersistenceAuthorization wiring
// ---------------------------------------------------------------------------

/**
 * Shape consumed by `recordAttendance` / `persistSessionAttendance`. The
 * authorization callback MUST be fail-closed: it returns `{ ok: false }`
 * whenever it cannot prove the user has an active grant.
 */
export type PersistenceAuthorization = {
  authorize: (subjectId: string, scope: "activity-history") => Promise<{ ok: boolean }>;
};

const revokedUsers = new Set<string>();
let currentAuthorization: PersistenceAuthorization | null = null;

/**
 * Wire a `ConsentService`-backed `PersistenceAuthorization` into the
 * engagement module. Subscribes to consent events so a revoke immediately
 * disables future persistence for that subject — independent of what the
 * authorization callback would later return.
 *
 * Returns an unsubscribe function that detaches both the authorization
 * reference and the event subscription.
 */
export function attachPersistenceAuthorization(
  authorization: PersistenceAuthorization,
  subscribe: (listener: (event: ConsentEvent) => void) => () => void,
): () => void {
  currentAuthorization = authorization;
  const unsubscribe = subscribe((event) => {
    if (event.kind === "revoke") {
      revokedUsers.add(event.subjectId);
      return;
    }
    if (event.kind === "grant") {
      revokedUsers.delete(event.subjectId);
      return;
    }
    if (event.kind === "clear") {
      revokedUsers.delete(event.subjectId);
    }
  });
  return () => {
    if (currentAuthorization === authorization) {
      currentAuthorization = null;
    }
    unsubscribe();
  };
}

/** Test-only: clear the module-level state introduced for v0.2.0 gating. */
export function __resetTimekeeperPersistenceState(): void {
  revokedUsers.clear();
  currentAuthorization = null;
}

/**
 * Test-only: synchronously check whether a subject has been flagged as
 * revoked outside of an explicit authorize call. The normal production
 * path uses `attachPersistenceAuthorization` so this is mostly a debug
 * surface; the timekeeper itself never reads from it.
 */
export function isRevokedForTesting(subjectId: string): boolean {
  return revokedUsers.has(subjectId);
}

function pickFortuneText(phaseCount: number, random: () => number): string {
  const tiers =
    phaseCount >= 5
      ? [
          "大吉、今日は床が先にこちらの予定を知っています。",
          "今日は中吉の廊下が一本だけ増えていて、そこを通る話が早いです。",
          "あなたの背後で吉の係員が二度うなずき、誰にも説明されません。",
          "今なら引き出しの空気が小吉として配属され、細かい判断を運びます。",
          "さっきの雑な仮置き、吉、もう正式名称みたいな顔をしています。",
          "今日は難所が中吉の服を着ており、威圧感だけ置いて帰ります。",
          "あなたの周囲だけ、末吉の静けさで話が先にまとまっています。",
          "今の手順は吉な霧に包まれていて、遠回りから先に到着します。",
          "大吉の気配だけが先着し、肝心の作業があとから追いついてきます。",
          "今日は机上に小吉の順番が落ちていて、拾うと妙に正しいです。",
          "見落としていたはずの項目が、吉、向こうから名乗ってきます。",
          "今なら中吉の余白が一番具体的で、本文のほうが遠慮しています。",
        ]
      : phaseCount === 4
        ? [
            "中吉、今日は半端なメモがやけに太い声で主張してきます。",
            "あなたの近くで吉だけ先に着席していて、本題はまだ廊下です。",
            "今日は背景が小吉として状況を理解し、前景が少し遅れています。",
            "さっき閉じた考え、吉な別口でまた入館してきました。",
            "今なら未決のものが中吉の落ち着きで黙って並んでいます。",
            "あなたの指先には吉の古地図が配られ、北だけ妙に確信があります。",
            "机の端で、まだ名前のない正解が末吉の顔で乾いています。",
            "今日は雑な仮説が吉として一度だけ公的な態度を取ります。",
            "今の判断、中吉、意味は後日ですが先に通ります。",
            "なぜか今日、後回しの列だけ吉な歩幅で前を向いています。",
            "あなたの席の周辺だけ小吉の気圧で、保留が少し薄いです。",
            "今日は余白が大吉、本文はそれを見て姿勢を正しています。",
          ]
        : phaseCount === 3
          ? [
              "吉、今日は途中のものほど完成を急いでいて落ち着きがありません。",
              "あなたの席の周辺だけ中吉の時間が流れ、秒針が少し丁寧です。",
              "今のところ話は通っていませんが、小吉の顔だけ先に通っています。",
              "さっき置いた仮の名前が吉として居座り、もう本名みたいです。",
              "今日は関係ない余白が中吉で、一番頼れる場所になっています。",
              "あなたの作業、吉な靴音だけ奥でしていて本体はまだ見えません。",
              "今の進み方には末吉の承認印が押され、誰の印鑑かは不明です。",
              "まだ途中なのに、結論だけ大吉の速度で近所へ引っ越してきました。",
              "今日の手元、小吉なくせに季節だけ一歩先です。",
              "今なら横道が吉として正面玄関を名乗り、守衛も困っていません。",
              "あなたの近辺でだけ中吉の保留が保留をやめかけています。",
              "今日は答えではなく、吉な親戚が先に来てお茶を飲んでいます。",
            ]
          : phaseCount === 2
            ? [
                "小吉、今日はまだ静かですが静かなものほどよく動いています。",
                "あなたの開始位置だけ吉で、地図にない事情を知っています。",
                "今の一手、中吉でも小声で少し先まで行っています。",
                "さっきの躊躇が吉の肩書きを得て、別室で働き始めました。",
                "今日は机上に末吉の気配があり、薄いのに無視しにくいです。",
                "あなたの周りだけ小吉の札が裏返りかけていて、準備中が落ち着きません。",
                "今の作業、吉、まだ名札はありませんが着席は済んでいます。",
                "関係ないと思っていた線が中吉の目つきでこちらを見ています。",
                "今日は手を動かすと、吉な意味だけ遅れて付いてきます。",
                "あなたの中で、まだ仮だったものが末吉の常連みたいに振る舞います。",
                "今のところ進捗ではありませんが、吉な前座としては態度が大きいです。",
                "今日は始まりが中吉のわりに落ち着いていて、むしろ不自然です。",
              ]
            : [
                "末吉、まだ何も起きていませんが何も起きていないにしては前向きです。",
                "あなたの着席だけ吉で処理され、本文はまだ提出されていません。",
                "今日は開始の気配が小吉の手つきで遠くから合図しています。",
                "今の状態、中吉、説明はありませんが配置だけ悪くありません。",
                "さっき開いた空白が吉としては妙に本気で、周囲が少し引いています。",
                "今日は一歩目の周辺に末吉の照明が当たり、そこだけ舞台です。",
                "あなたの机、吉、まだ無言ですが無関係ではなさそうです。",
                "今は助走より前ですが、小吉の担当者はもう現地入りしています。",
                "今日は始まっていない感じのまま中吉が少しだけ混ざっています。",
                "まだ輪郭はありませんが、吉な輪郭係はすでに腕組みしています。",
                "今のところただの最初ですが、末吉のわりに態度が大きいです。",
                "今日は空気が吉として先に座っていて、あなたはそのあとです。",
              ];

  return tiers[Math.floor(random() * tiers.length)] ?? tiers[0]!;
}

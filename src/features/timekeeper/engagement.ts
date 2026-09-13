import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { TimekeeperEventKind } from "./timeline.js";
import { fetchRandomWikipediaTopic, type WikipediaTopic } from "./wikipedia.js";

export type TimekeeperSessionStatus = "active" | "cancelled" | "completed" | "interrupted";

export type TimekeeperSessionEngagement = {
  attendanceDatesByUserId: Map<string, Set<string>>;
  checkInsByUserId: Map<string, Set<number>>;
  endedAt?: string;
  id: string;
  startedAt: string;
  status: TimekeeperSessionStatus;
};

type PersistedAttendance = Record<string, string[]>;

const historyPath = join(process.cwd(), "data", "timekeeper-history.json");

type FortuneDependencies = {
  fetchRandomTopic?: () => Promise<WikipediaTopic>;
};

export function createSessionEngagement(id: string): TimekeeperSessionEngagement {
  return {
    attendanceDatesByUserId: loadAttendanceHistory(),
    id,
    checkInsByUserId: new Map(),
    startedAt: new Date().toISOString(),
    status: "active",
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

export function recordAttendance(
  session: TimekeeperSessionEngagement,
  userId: string,
  date: string,
): void {
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

export function persistSessionAttendance(session: TimekeeperSessionEngagement, date: string): void {
  for (const userId of session.checkInsByUserId.keys()) {
    recordAttendance(session, userId, date);
  }

  const serialized: PersistedAttendance = {};
  for (const [userId, dates] of session.attendanceDatesByUserId.entries()) {
    serialized[userId] = [...dates].sort();
  }

  mkdirSync(dirname(historyPath), { recursive: true });
  writeFileSync(historyPath, JSON.stringify(serialized, null, 2), "utf8");
}

function loadAttendanceHistory(): Map<string, Set<string>> {
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

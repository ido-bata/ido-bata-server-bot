const JST_OFFSET_MINUTES = 9 * 60;

export function getNextSnapshotStartAt(
  now: Date,
  snapshotHourJst: number,
  snapshotMinuteJst: number,
): Date {
  const nowJst = new Date(now.getTime() + JST_OFFSET_MINUTES * 60_000);
  const candidateJst = new Date(
    Date.UTC(
      nowJst.getUTCFullYear(),
      nowJst.getUTCMonth(),
      nowJst.getUTCDate(),
      snapshotHourJst,
      snapshotMinuteJst,
      0,
      0,
    ),
  );

  if (candidateJst.getTime() <= nowJst.getTime()) {
    candidateJst.setUTCDate(candidateJst.getUTCDate() + 1);
  }

  return new Date(candidateJst.getTime() - JST_OFFSET_MINUTES * 60_000);
}
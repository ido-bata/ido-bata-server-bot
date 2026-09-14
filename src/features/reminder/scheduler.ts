import type { PersistedReminder } from "./store.js";

export type ReminderFire = {
  reminder: PersistedReminder;
  fireAt: Date;
};

/**
 * Compute the next absolute fire time for a single reminder entry.
 * Returns null when the reminder is already in the past relative to `now`.
 */
export function getNextFireTime(reminder: PersistedReminder, now: Date): Date | null {
  const fireAt = new Date(reminder.fireAt);
  if (Number.isNaN(fireAt.getTime())) {
    return null;
  }
  if (fireAt.getTime() <= now.getTime()) {
    return null;
  }
  return fireAt;
}

/**
 * Pick reminders due at or before `now`, ordered by fire time so that
 * catch-up after a bot restart fires chronologically.
 */
export function pickOverdueReminders(
  reminders: readonly PersistedReminder[],
  now: Date,
): ReminderFire[] {
  const fires: ReminderFire[] = [];
  for (const reminder of reminders) {
    const fireAt = new Date(reminder.fireAt);
    if (Number.isNaN(fireAt.getTime())) {
      continue;
    }
    if (fireAt.getTime() > now.getTime()) {
      continue;
    }
    fires.push({ reminder, fireAt });
  }
  fires.sort((left, right) => left.fireAt.getTime() - right.fireAt.getTime());
  return fires;
}

/**
 * Pick the next reminder that is still in the future relative to `now`.
 * Used both for diagnostic logging and for scheduling the wake-up timer.
 */
export function pickNextFire(
  reminders: readonly PersistedReminder[],
  now: Date,
): ReminderFire | null {
  let best: ReminderFire | null = null;

  for (const reminder of reminders) {
    const fireAt = getNextFireTime(reminder, now);
    if (!fireAt) {
      continue;
    }
    if (!best || fireAt.getTime() < best.fireAt.getTime()) {
      best = { reminder, fireAt };
    }
  }

  return best;
}

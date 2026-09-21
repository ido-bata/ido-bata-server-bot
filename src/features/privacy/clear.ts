/**
 * Aggregator that runs every consent-gated consumer's delete adapter and
 * reports the outcome to `/privacy delete`.
 *
 * Invariants:
 *   - **Partial failure = failure.** `ok` on the returned report is `true`
 *     ONLY if every per-consumer adapter succeeded. A single non-ok entry
 *     marks the whole clear as a failure, so the slash command can warn
 *     the operator and the user instead of declaring victory.
 *   - **Adapters are run sequentially.** The privacy clear path is rare
 *     and not on a hot loop, so we keep this readable and let one
 *     permission failure surface before the next adapter runs.
 */

import { deleteUserData as deleteBirthdayData } from "./consumers/birthday.js";
import { deleteUserData as deletePollData } from "./consumers/poll.js";
import { deleteUserData as deleteReminderData } from "./consumers/reminder.js";
import { deleteUserData as deleteSnapshotData } from "./consumers/state-snapshot.js";
import { deleteUserData as deleteTimekeeperData } from "./consumers/timekeeper.js";
import type { DeleteResult } from "./types.js";

export type ConsumerDeleteAdapter = (userId: string) => Promise<DeleteResult>;

export type ClearConsumerResult = {
  consumer: string;
  ok: boolean;
  error?: string;
};

export type ClearReport = {
  /** True ONLY when every consumer returned ok: true. */
  ok: boolean;
  /** Per-consumer outcomes in iteration order. */
  results: ClearConsumerResult[];
  subjectId: string;
};

/**
 * Canonical ordering of consumer delete adapters. The order matches the
 * consent-gated list in `consumer-inventory.ts` so `/privacy delete` and
 * `ConsentService.clear` walk the same priority.
 */
const CONSUMER_ADAPTERS: ReadonlyArray<{ consumer: string; adapter: ConsumerDeleteAdapter }> = [
  { adapter: deleteTimekeeperData, consumer: "timekeeper-history" },
  { adapter: deleteBirthdayData, consumer: "birthday" },
  { adapter: deletePollData, consumer: "poll" },
  { adapter: deleteReminderData, consumer: "reminder" },
  { adapter: deleteSnapshotData, consumer: "state-snapshot" },
];

export async function clearUserData(subjectId: string): Promise<ClearReport> {
  const results: ClearConsumerResult[] = [];

  for (const { consumer, adapter } of CONSUMER_ADAPTERS) {
    let outcome: DeleteResult;
    try {
      outcome = await adapter(subjectId);
    } catch (error) {
      outcome = { ok: false, error: stringifyError(error) };
    }
    results.push(
      outcome.ok ? { consumer, ok: true } : { consumer, ok: false, error: outcome.error },
    );
  }

  const ok = results.every((result) => result.ok);
  return { ok, results, subjectId };
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

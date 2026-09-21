/**
 * Aggregator that runs every consent-gated consumer's delete adapter and
 * reports the outcome to `/privacy delete`.
 *
 * Invariants:
 *   - **Partial failure = failure.** `ok` on the returned report is `true`
 *     ONLY if every per-consumer adapter succeeded AND the consent registry
 *     itself cleared. A single non-ok entry marks the whole clear as a
 *     failure, so the slash command can warn the operator and the user
 *     instead of declaring victory.
 *   - **Adapters are run sequentially.** The privacy clear path is rare
 *     and not on a hot loop, so we keep this readable and let one
 *     permission failure surface before the next adapter runs.
 *   - **Consent registry is also cleared.** `data/consent.json` holds the
 *     user's grants; deleting only the consumer data leaves those records
 *     intact, which would re-authorize the next scrape. The slash command
 *     passes the live `ConsentService` so we can run `clear()` and emit
 *     the `clear` event the snapshot scheduler subscribes to.
 */

import type { ConsentService } from "../../consent/service.js";
import { deleteUserData as deleteBirthdayData } from "./consumers/birthday.js";
import { deleteUserData as deletePollData } from "./consumers/poll.js";
import { deleteUserData as deleteReminderData } from "./consumers/reminder.js";
import { deleteUserData as deleteSnapshotData } from "./consumers/state-snapshot.js";
import { deleteUserData as deleteTimekeeperData } from "./consumers/timekeeper.js";
import type { DeleteResult } from "./types.js";

export type ConsumerDeleteAdapter = (
  userId: string,
  options?: Record<string, unknown>,
) => Promise<DeleteResult>;

export type ClearConsumerResult = {
  consumer: string;
  ok: boolean;
  error?: string;
};

export type ClearReport = {
  /** True ONLY when every consumer + the consent registry cleared. */
  ok: boolean;
  /** Per-consumer outcomes in iteration order, plus the `consent-registry` slot. */
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

export type ClearUserDataOptions = {
  /**
   * Live consent service. When provided, `clearUserData` also calls
   * `ConsentService.clear(subjectId)` so the grant records in
   * `data/consent.json` are purged and the `clear` event fires (snapshot
   * scheduler subscribes to it).
   *
   * When omitted (e.g. tests of consumer adapters in isolation), the
   * consent step is skipped and the consumer results stand on their own.
   */
  consentService?: ConsentService;
  /**
   * Capture the post-clear state into a fresh snapshot before the
   * snapshot subsystem reaps every pre-existing encrypted file. Required
   * for the `state-snapshot` consumer to be safe — without it the
   * destructive purge is skipped and the consumer returns ok:false with
   * a wiring error, so the slash command surfaces the misconfiguration
   * instead of silently leaking data. Wired in `src/index.ts` to the
   * snapshot runtime's `runSnapshotOnce(runtime)`.
   */
  takeFreshSnapshot?: () => Promise<string | null>;
};

export async function clearUserData(
  subjectId: string,
  options: ClearUserDataOptions = {},
): Promise<ClearReport> {
  const results: ClearConsumerResult[] = [];

  for (const { consumer, adapter } of CONSUMER_ADAPTERS) {
    let outcome: DeleteResult;
    try {
      outcome = await adapter(subjectId, consumer === "state-snapshot"
        ? { takeFreshSnapshot: options.takeFreshSnapshot }
        : {});
    } catch (error) {
      outcome = { ok: false, error: stringifyError(error) };
    }
    results.push(
      outcome.ok ? { consumer, ok: true } : { consumer, ok: false, error: outcome.error },
    );
  }

  // Consent registry last — if any consumer above failed, the operator
  // already knows the clear is partial-failure. We still try the consent
  // step because the user explicitly asked to be forgotten; the partial
  // failure of a downstream consumer does not justify leaving the grant
  // records in place.
  if (options.consentService) {
    try {
      const clearReport = await options.consentService.clear(subjectId);
      const allConsentOk = clearReport.results.every((r) => r.ok);
      const firstError = clearReport.results.find((r) => !r.ok)?.error;
      results.push(
        allConsentOk
          ? { consumer: "consent-registry", ok: true }
          : {
              consumer: "consent-registry",
              ok: false,
              error: firstError ?? "consent clear failed",
            },
      );
    } catch (error) {
      results.push({
        consumer: "consent-registry",
        ok: false,
        error: stringifyError(error),
      });
    }
  }

  const ok = results.every((result) => result.ok);
  return { ok, results, subjectId };
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

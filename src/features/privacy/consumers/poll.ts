/**
 * Per-consumer delete adapter for the poll feature.
 *
 * Removes the user's votes from every poll in `data/polls.json` and, if the
 * user owns the poll, drops the whole poll record. The aggregator in
 * `src/features/privacy/clear.ts` runs the adapter for every user; deleting
 * owned polls here keeps the on-disk state self-consistent with what the
 * user sees in `/privacy status`.
 *
 * The on-disk shape includes a `{ version: 1, polls: [...] }` wrapper. We
 * require `version: 1` and a list of polls with the minimum fields the
 * privacy adapter reads (creatorId, votes) — passing through every other
 * poll field (question, options, createdAt, ...) so the rewritten file
 * remains bit-for-bit identical apart from the dropped entries. The poll
 * feature's own loader uses a stricter schema (`pollStateFileSchema`) and
 * would reject the file as "schema mismatch" if we dropped `version`.
 *
 * Failures (read / parse / schema / write) surface as `{ ok: false, error }`
 * — ENOENT (no persisted file) is treated as success, since there is
 * nothing to remove.
 */
import { z } from "zod";
import { mutateJsonObject } from "../../../lib/storage/json.js";
import { STORAGE_KEYS } from "../../../lib/storage/keys.js";
import { resolveStorageTarget } from "../../../lib/storage/target.js";
import type { StorageDriver } from "../../../lib/storage/types.js";
import type { DeleteResult } from "../types.js";

export type PollDeleteOptions = {
  /**
   * Legacy filesystem path. Kept for operators and tests that pin the
   * store to one file; the store is then served by a local filesystem
   * driver rooted at its directory.
   */
  filePath?: string;
  /** Storage backend holding the store. */
  driver?: StorageDriver;
  /** Storage key of the store. Defaults to the canonical key. */
  key?: string;
};

// Minimal-but-strict-enough schema for the privacy adapter: validates the
// `version` wrapper (so the next `pollStateFileSchema` parse succeeds)
// and the fields the deletion mutates (creatorId, votes). All other
// fields pass through verbatim so the production poll loader can re-read
// the file without surprises.
const privacyPollSchema = z
  .object({
    creatorId: z.string().min(1),
    id: z.string().min(1),
    votes: z.record(z.string(), z.number()),
  })
  .passthrough();

const storeSchema = z.object({
  version: z.literal(1),
  polls: z.array(privacyPollSchema),
});

export function deleteUserData(
  userId: string,
  options: PollDeleteOptions = {},
): Promise<DeleteResult> {
  return runDelete(userId, options);
}

async function runDelete(userId: string, options: PollDeleteOptions): Promise<DeleteResult> {
  const { driver, key } = resolveStorageTarget({
    defaultKey: STORAGE_KEYS.polls,
    driver: options.driver,
    filePath: options.filePath,
    key: options.key,
  });
  const outcome = await mutateJsonObject({
    driver,
    key,
    schema: storeSchema,
    mutate: (current) => {
      let changed = false;
      const nextPolls: z.infer<typeof privacyPollSchema>[] = [];
      for (const poll of current.polls) {
        if (poll.creatorId === userId) {
          // Drop polls the user created; votes for those polls cannot exist
          // elsewhere once the parent record is gone.
          changed = true;
          continue;
        }
        if (userId in poll.votes) {
          const nextVotes = { ...poll.votes };
          delete nextVotes[userId];
          changed = true;
          nextPolls.push({ ...poll, votes: nextVotes });
          continue;
        }
        nextPolls.push(poll);
      }
      if (!changed) {
        return current;
      }
      return { version: 1 as const, polls: nextPolls };
    },
  });

  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  return { ok: true };
}

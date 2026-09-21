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
import { join } from "node:path";
import { z } from "zod";

import { mutateJsonFile } from "../../../lib/storage/atomic-json.js";
import type { DeleteResult } from "../types.js";

export type PollDeleteOptions = {
  filePath?: string;
};

const DEFAULT_RELATIVE_PATH = "data/polls.json";

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

function resolveFilePath(options: PollDeleteOptions): string {
  if (options.filePath) {
    return options.filePath;
  }
  return join(process.cwd(), DEFAULT_RELATIVE_PATH);
}

export function deleteUserData(
  userId: string,
  options: PollDeleteOptions = {},
): Promise<DeleteResult> {
  return runDelete(userId, options);
}

async function runDelete(userId: string, options: PollDeleteOptions): Promise<DeleteResult> {
  const filePath = resolveFilePath(options);
  const outcome = await mutateJsonFile({
    filePath,
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

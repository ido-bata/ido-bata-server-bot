/**
 * Per-consumer delete adapter for the poll feature.
 *
 * Removes the user's votes from every poll in `data/polls.json` and, if the
 * user owns the poll, drops the whole poll record. The aggregator in
 * `src/features/privacy/clear.ts` runs the adapter for every user; deleting
 * owned polls here keeps the on-disk state self-consistent with what the
 * user sees in `/privacy status`.
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

const pollSchema = z
  .object({
    creatorId: z.string(),
    id: z.string(),
    votes: z.record(z.string(), z.number()),
  })
  .passthrough();

const storeSchema = z.object({
  polls: z.array(pollSchema),
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
    mutate: (current) => {
      let changed = false;
      const nextPolls: z.infer<typeof pollSchema>[] = [];
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
      return { polls: nextPolls };
    },
    schema: storeSchema,
  });

  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  return { ok: true };
}

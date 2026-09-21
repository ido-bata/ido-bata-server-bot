/**
 * Per-consumer delete adapter for the poll feature.
 *
 * Removes the user's votes from every poll in `data/polls.json` and, if the
 * user owns the poll, the whole poll record. The aggregator in
 * `src/features/privacy/clear.ts` runs the adapter for every user; deleting
 * owned polls here keeps the on-disk state self-consistent with what the
 * user sees in `/privacy status`.
 *
 * Corrupt or missing files are treated as soft success.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DeleteResult } from "../types.js";

export type PollDeleteOptions = {
  filePath?: string;
};

const DEFAULT_RELATIVE_PATH = "data/polls.json";

function resolveFilePath(options: PollDeleteOptions): string {
  if (options.filePath) {
    return options.filePath;
  }
  return join(process.cwd(), DEFAULT_RELATIVE_PATH);
}

type PollEntry = {
  id: string;
  creatorId: string;
  votes: Record<string, number>;
  [key: string]: unknown;
};
type PollStore = { version?: number; polls?: PollEntry[] };

export function deleteUserData(
  userId: string,
  options: PollDeleteOptions = {},
): Promise<DeleteResult> {
  const filePath = resolveFilePath(options);

  if (!existsSync(filePath)) {
    return Promise.resolve({ ok: true });
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    let parsed: PollStore;
    try {
      parsed = JSON.parse(raw) as PollStore;
    } catch {
      return Promise.resolve({ ok: true });
    }
    const polls = Array.isArray(parsed.polls) ? parsed.polls : [];
    let changed = false;
    const nextPolls: PollEntry[] = [];
    for (const poll of polls) {
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
      return Promise.resolve({ ok: true });
    }
    const payload = JSON.stringify({ ...parsed, polls: nextPolls }, null, 2);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, payload, "utf8");
    return Promise.resolve({ ok: true });
  } catch (error) {
    return Promise.resolve({ ok: false, error: stringifyError(error) });
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

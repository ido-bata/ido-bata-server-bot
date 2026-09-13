import type { Poll } from "./state.js";

export type PollTally = {
  // Counts per option, parallel to `poll.options`. Always exactly poll.options.length entries.
  counts: number[];
  totalVotes: number;
  // Indices of the options with the highest count. Length >= 1.
  leaders: number[];
};

export type PollTallyRow = {
  index: number;
  label: string;
  count: number;
  // Percentage of totalVotes, rounded to one decimal. 0 when there are no votes.
  percentage: number;
};

export function tallyPoll(poll: Poll): PollTally {
  const counts = new Array<number>(poll.options.length).fill(0);

  for (const optionIndex of Object.values(poll.votes)) {
    if (optionIndex >= 0 && optionIndex < counts.length) {
      counts[optionIndex] = (counts[optionIndex] ?? 0) + 1;
    }
  }

  const totalVotes = counts.reduce((sum, count) => sum + count, 0);
  const leaders: number[] = [];

  if (totalVotes > 0) {
    let highest = -Infinity;
    for (const [index, count] of counts.entries()) {
      if (count > highest) {
        highest = count;
        leaders.length = 0;
        leaders.push(index);
      } else if (count === highest) {
        leaders.push(index);
      }
    }
  }

  return { counts, totalVotes, leaders };
}

export function buildTallyRows(poll: Poll): PollTallyRow[] {
  const tally = tallyPoll(poll);

  return poll.options.map((label, index) => {
    const count = tally.counts[index] ?? 0;
    const percentage =
      tally.totalVotes === 0 ? 0 : Math.round((count / tally.totalVotes) * 1000) / 10;
    return { index, label, count, percentage };
  });
}

/**
 * Apply a vote for `userId` on `optionIndex` to a draft Poll. Last-write-wins
 * per the issue acceptance criteria: re-voting overwrites the previous choice.
 * Returns a new Poll (the input is not mutated) and a `previousOption` so the
 * caller can decide whether to emit a "vote changed" message.
 */
export function applyVote(
  poll: Poll,
  userId: string,
  optionIndex: number,
): { next: Poll; previousOption: number | null; changed: boolean } {
  if (optionIndex < 0 || optionIndex >= poll.options.length) {
    throw new Error(`Invalid option index ${optionIndex} for poll ${poll.id}`);
  }

  const previousOption = poll.votes[userId] ?? null;
  const votes = { ...poll.votes, [userId]: optionIndex };
  const next: Poll = { ...poll, votes };
  // "changed" means the user's prior vote differed from the new one. A first
  // vote has previousOption === null, which is not a change.
  const changed = previousOption !== null && previousOption !== optionIndex;

  return { next, previousOption, changed };
}

export function clearVote(poll: Poll, userId: string): { next: Poll; hadVote: boolean } {
  if (!(userId in poll.votes)) {
    return { next: poll, hadVote: false };
  }

  const votes = { ...poll.votes };
  delete votes[userId];
  return { next: { ...poll, votes }, hadVote: true };
}

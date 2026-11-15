import { basename, dirname } from "node:path";

import { z } from "zod";

import { childFor, getRootLogger } from "../../lib/logger/index.js";
import { createLocalFileStorage } from "../../lib/storage/local.js";
import type { StorageDriver } from "../../lib/storage/types.js";

const logger = childFor(getRootLogger(), "poll");

// Internal: validation bounds for poll options. Kept module-private because
// no external consumer imports them; if a future migration tool needs them,
// re-export then.
const MAX_POLL_OPTIONS = 10;
const MIN_POLL_OPTIONS = 2;

const pollOptionLabelSchema = z
  .string()
  .trim()
  .min(1, "Option label must not be empty")
  .max(80, "Option label must be 80 characters or fewer");

export const pollOptionsSchema = z
  .array(pollOptionLabelSchema)
  .min(MIN_POLL_OPTIONS, `A poll requires at least ${MIN_POLL_OPTIONS} options`)
  .max(MAX_POLL_OPTIONS, `A poll supports at most ${MAX_POLL_OPTIONS} options`)
  .refine(
    (options) => new Set(options.map((option) => option.toLowerCase())).size === options.length,
    "Option labels must be unique",
  );

export const pollQuestionSchema = z
  .string()
  .trim()
  .min(1, "Question must not be empty")
  .max(200, "Question must be 200 characters or fewer");

// Internal: full Poll validation schema. Used by pollStateFileSchema below
// and exposed via the `Poll` type only; the runtime schema is not part of
// the public surface.
const pollSchema = z
  .object({
    id: z.string().min(1),
    guildId: z.string().min(1),
    channelId: z.string().min(1),
    messageId: z.string().min(1),
    question: pollQuestionSchema,
    options: pollOptionsSchema,
    creatorId: z.string().min(1),
    createdAt: z.string().min(1),
    closed: z.boolean().default(false),
    closedAt: z.string().min(1).optional(),
    // userId -> optionIndex (0-based). Last write wins on duplicate votes.
    votes: z.record(z.string(), z.number().int().min(0)).default({}),
  })
  .superRefine((poll, ctx) => {
    const optionCount = poll.options.length;
    for (const [userId, optionIndex] of Object.entries(poll.votes)) {
      if (optionIndex >= optionCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["votes", userId],
          message: `vote index ${optionIndex} is out of range for ${optionCount} options`,
        });
      }
    }
  });

export type Poll = z.infer<typeof pollSchema>;

export type PollStateFile = {
  // Schema version. Bump when making breaking changes to the JSON shape.
  version: 1;
  polls: Poll[];
};

export const pollStateFileSchema = z.object({
  version: z.literal(1),
  polls: z.array(pollSchema),
});

export function createPollState(): PollStateFile {
  return { version: 1, polls: [] };
}

export type PollStore = {
  load: () => Promise<PollStateFile>;
  save: (state: PollStateFile) => Promise<void>;
  /** Storage key of the poll state. */
  path: string;
};

/**
 * Returns a PollStore backed by a single JSON file. The store is intentionally
 * tiny: load() reads the whole file, save() writes it back. We keep the schema
 * intentionally narrow so that future migration to SQLite (issue #25) is just
 * a translator away from this representation.
 */
export function createPollStore(options: { driver: StorageDriver; key: string }): PollStore {
  async function load(): Promise<PollStateFile> {
    const raw = await options.driver.readText(options.key);
    if (raw === null || raw.trim().length === 0) {
      return createPollState();
    }

    const parsed = JSON.parse(raw) as unknown;
    const result = pollStateFileSchema.safeParse(parsed);

    if (!result.success) {
      // Corrupt state should not bring the bot down. Log and start fresh; a
      // future migration tool can recover from the original object.
      logger.warn(
        { key: options.key, reason: result.error.message },
        "discarding unparseable state file",
      );
      return createPollState();
    }

    return result.data;
  }

  async function save(state: PollStateFile): Promise<void> {
    await options.driver.write(options.key, `${JSON.stringify(state, null, 2)}\n`);
  }

  return { load, save, path: options.key };
}

/** Poll state pinned to one file on the local filesystem (tests, operators). */
export function createFilePollStore(filePath: string): PollStore {
  return createPollStore({
    driver: createLocalFileStorage({ root: dirname(filePath) }),
    key: basename(filePath),
  });
}

export function findPollByMessageId(state: PollStateFile, messageId: string): Poll | undefined {
  return state.polls.find((poll) => poll.messageId === messageId);
}

export function findPollById(state: PollStateFile, pollId: string): Poll | undefined {
  return state.polls.find((poll) => poll.id === pollId);
}

export function upsertPoll(state: PollStateFile, poll: Poll): PollStateFile {
  const existingIndex = state.polls.findIndex((entry) => entry.id === poll.id);
  const next = [...state.polls];

  if (existingIndex === -1) {
    next.push(poll);
  } else {
    next[existingIndex] = poll;
  }

  return { version: 1, polls: next };
}

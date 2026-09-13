import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

export const MAX_POLL_OPTIONS = 10;
export const MIN_POLL_OPTIONS = 2;

export const pollOptionLabelSchema = z
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

export const pollSchema = z
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
  load: () => PollStateFile;
  save: (state: PollStateFile) => void;
  path: string;
};

/**
 * Returns a PollStore backed by a single JSON file. The store is intentionally
 * tiny: load() reads the whole file, save() writes it back. We keep the schema
 * intentionally narrow so that future migration to SQLite (issue #25) is just
 * a translator away from this representation.
 */
export function createFilePollStore(filePath: string): PollStore {
  function load(): PollStateFile {
    if (!existsSync(filePath)) {
      return createPollState();
    }

    const raw = readFileSync(filePath, "utf8");

    if (raw.trim().length === 0) {
      return createPollState();
    }

    const parsed = JSON.parse(raw) as unknown;
    const result = pollStateFileSchema.safeParse(parsed);

    if (!result.success) {
      // Corrupt state should not bring the bot down. Log and start fresh; a
      // future migration tool can recover from the original file.
      console.warn(`[poll] Discarding unparseable state file ${filePath}: ${result.error.message}`);
      return createPollState();
    }

    return result.data;
  }

  function save(state: PollStateFile): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  }

  return { load, save, path: filePath };
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

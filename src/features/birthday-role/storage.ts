// Persistence for registered birthdays. Stored as a flat JSON map keyed by
// Discord user id. The on-disk format is intentionally simple so it can be
// inspected and edited by hand during recovery.

import { z } from "zod";
import {
  type MutateJsonFileResult,
  mutateJsonFile,
  readJsonFile,
} from "../../lib/storage/atomic-json.js";

export type BirthdayEntry = {
  // Discord user id (snowflake).
  userId: string;
  // Stored as the canonical YYYY-MM-DD string so the file remains diffable.
  date: string;
  // ISO timestamp of the most recent write. Useful for debugging only.
  updatedAt: string;
};

export type BirthdayStore = {
  birthdays: Record<string, BirthdayEntry>;
};

export type BirthdayStorage = {
  load: () => Promise<BirthdayStore>;
  /**
   * Persist `store` to disk via the shared atomic JSON helper. Returns the
   * underlying result so callers can distinguish mutation success from a
   * schema mismatch on the on-disk file.
   */
  save: (store: BirthdayStore) => Promise<MutateJsonFileResult>;
};

const birthdayEntrySchema = z.object({
  userId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
  updatedAt: z.string().min(1),
});

const birthdayStoreSchema = z.object({
  birthdays: z.record(z.string(), birthdayEntrySchema),
});

const EMPTY_STORE: BirthdayStore = { birthdays: {} };

export function createFileBirthdayStorage(filePath: string): BirthdayStorage {
  async function load(): Promise<BirthdayStore> {
    const result = readJsonFile({ filePath, schema: birthdayStoreSchema });
    if (!result.ok) {
      if (result.error === "ENOENT") {
        return EMPTY_STORE;
      }
      // A non-ENOENT read failure (corrupt JSON, schema mismatch, permission
      // error, etc.) must surface — silent swallowing would let a bot
      // restart with a truncated file nuke the persisted registry.
      throw new Error(`birthday storage: load failed: ${result.error}`);
    }
    return result.value;
  }

  async function save(store: BirthdayStore): Promise<MutateJsonFileResult> {
    return mutateJsonFile({
      filePath,
      schema: birthdayStoreSchema,
      mutate: () => ({ birthdays: { ...store.birthdays } }),
    });
  }

  return { load, save };
}

export function createInMemoryBirthdayStorage(
  initial: BirthdayStore = { birthdays: {} },
): BirthdayStorage {
  let state: BirthdayStore = {
    birthdays: { ...initial.birthdays },
  };

  return {
    load: async () => ({ birthdays: { ...state.birthdays } }),
    save: async (next) => {
      state = { birthdays: { ...next.birthdays } };
      return { ok: true, mutated: true };
    },
  };
}

export function setBirthday(
  store: BirthdayStore,
  userId: string,
  date: string,
  now: Date = new Date(),
): BirthdayStore {
  return {
    birthdays: {
      ...store.birthdays,
      [userId]: {
        userId,
        date,
        updatedAt: now.toISOString(),
      },
    },
  };
}

export function removeBirthday(store: BirthdayStore, userId: string): BirthdayStore {
  if (!(userId in store.birthdays)) {
    return store;
  }

  const { [userId]: _removed, ...rest } = store.birthdays;
  void _removed;
  return { birthdays: rest };
}

export function listBirthdays(store: BirthdayStore): BirthdayEntry[] {
  return Object.values(store.birthdays);
}

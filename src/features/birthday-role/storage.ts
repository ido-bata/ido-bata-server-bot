// Persistence for registered birthdays. Stored as a flat JSON map keyed by
// Discord user id. The on-disk format is intentionally simple so it can be
// inspected and edited by hand during recovery.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

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
  save: (store: BirthdayStore) => Promise<void>;
};

export function createFileBirthdayStorage(filePath: string): BirthdayStorage {
  async function load(): Promise<BirthdayStore> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;

      if (!parsed || typeof parsed !== "object") {
        return { birthdays: {} };
      }

      const record = parsed as Partial<BirthdayStore>;
      const birthdays = record.birthdays;

      if (!birthdays || typeof birthdays !== "object") {
        return { birthdays: {} };
      }

      return { birthdays: { ...birthdays } };
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return { birthdays: {} };
      }
      throw error;
    }
  }

  async function save(store: BirthdayStore): Promise<void> {
    await fs.mkdir(dirname(filePath), { recursive: true });
    const payload = JSON.stringify(store, null, 2);
    await fs.writeFile(filePath, `${payload}\n`, "utf8");
  }

  return { load, save };
}

export function createInMemoryBirthdayStorage(initial: BirthdayStore = { birthdays: {} }): BirthdayStorage {
  let state: BirthdayStore = {
    birthdays: { ...initial.birthdays },
  };

  return {
    load: async () => ({ birthdays: { ...state.birthdays } }),
    save: async (next) => {
      state = { birthdays: { ...next.birthdays } };
    },
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
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

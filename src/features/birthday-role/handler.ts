// Business logic for the birthday-role feature. All Discord-side effects
// (role assignments, channel messages) are funneled through DI seams so
// tests can exercise the logic without a live Client.

import { type BirthdayRoleConfig, isBirthdayRoleConfigured } from "./config.js";
import { parseBirthdayDate, toJstDate } from "./date.js";
import {
  createFileBirthdayStorage,
  listBirthdays,
  removeBirthday,
  setBirthday,
  type BirthdayEntry,
  type BirthdayStorage,
} from "./storage.js";

type MemberLike = {
  id: string;
  roles: {
    cache: { has: (roleId: string) => boolean };
    add: (roleId: string) => Promise<unknown>;
    remove: (roleId: string) => Promise<unknown>;
  };
};

type TextChannelLike = {
  send: (content: string) => Promise<unknown>;
};

export type HandlerDependencies = {
  config: BirthdayRoleConfig;
  storage?: BirthdayStorage;
  // Returns a Discord-like member. Lets tests inject deterministic stubs.
  fetchMember?: (userId: string) => Promise<MemberLike | null>;
  // Returns a Discord-like text channel for announcements. Optional — if the
  // channel id is empty the handler skips announcements.
  fetchAnnouncementChannel?: () => Promise<TextChannelLike | null>;
  // Lets tests intercept the wall-clock without touching Date.
  now?: () => Date;
};

export type BirthdayRoleHandler = {
  setBirthday: (userId: string, dateInput: string) => Promise<
    | { ok: true; entry: BirthdayEntry }
    | { ok: false; reason: "invalid-date" | "storage-failed" }
  >;
  removeBirthday: (userId: string) => Promise<{ removed: boolean }>;
  runAssignTick: () => Promise<AssignTickResult>;
  runRemoveTick: () => Promise<RemoveTickResult>;
};

export type AssignTickResult = {
  attempted: string[];
  granted: string[];
  skippedAlreadyHadRole: string[];
  failed: string[];
  announcedTo: string | null;
};

export type RemoveTickResult = {
  attempted: string[];
  removed: string[];
  skippedNoRole: string[];
  failed: string[];
};

export function createBirthdayRoleHandler(deps: HandlerDependencies): BirthdayRoleHandler {
  const config = deps.config;
  const storage: BirthdayStorage = deps.storage ?? createFileBirthdayStorage(config.dataFile);
  const now = deps.now ?? (() => new Date());

  if (!isBirthdayRoleConfigured(config)) {
    return createNoopHandler();
  }

  async function setBirthdayFor(userId: string, dateInput: string) {
    const parsed = parseBirthdayDate(dateInput);

    if (!parsed) {
      return { ok: false as const, reason: "invalid-date" as const };
    }

    const canonical = `${pad(parsed.year, 4)}-${pad(parsed.month, 2)}-${pad(parsed.day, 2)}`;

    try {
      const store = await storage.load();
      const next = setBirthday(store, userId, canonical, now());
      await storage.save(next);
    } catch {
      return { ok: false as const, reason: "storage-failed" as const };
    }

    return {
      ok: true as const,
      entry: {
        userId,
        date: canonical,
        updatedAt: now().toISOString(),
      },
    };
  }

  async function removeBirthdayFor(userId: string) {
    const store = await storage.load();

    if (!(userId in store.birthdays)) {
      return { removed: false };
    }

    const next = removeBirthday(store, userId);
    await storage.save(next);
    return { removed: true };
  }

  async function runAssignTick(): Promise<AssignTickResult> {
    const today = toJstDate(now());
    const store = await storage.load();
    const todays = listBirthdays(store).filter((entry) => {
      const parsed = parseBirthdayDate(entry.date);
      return parsed !== null && parsed.month === today.month && parsed.day === today.day;
    });

    const result: AssignTickResult = {
      attempted: todays.map((entry) => entry.userId),
      granted: [],
      skippedAlreadyHadRole: [],
      failed: [],
      announcedTo: null,
    };

    for (const entry of todays) {
      const member = deps.fetchMember ? await deps.fetchMember(entry.userId) : null;

      if (!member) {
        // Member missing (left the guild, fetch failed, etc.). Skip silently —
        // we never want a stale entry to take down the daily pass.
        continue;
      }

      if (member.roles.cache.has(config.roleId)) {
        result.skippedAlreadyHadRole.push(entry.userId);
        continue;
      }

      try {
        await member.roles.add(config.roleId);
        result.granted.push(entry.userId);
      } catch {
        result.failed.push(entry.userId);
      }
    }

    if (result.granted.length > 0 && deps.fetchAnnouncementChannel && config.announcementChannelId) {
      try {
        const channel = await deps.fetchAnnouncementChannel();
        if (channel) {
          const names = result.granted.map((id) => `<@${id}>`).join(", ");
          const message = `Happy birthday to ${names}! :birthday: :tada:`;
          await channel.send(message);
          result.announcedTo = config.announcementChannelId;
        }
      } catch {
        // Announcement is best-effort; do not propagate.
      }
    }

    return result;
  }

  async function runRemoveTick(): Promise<RemoveTickResult> {
    const store = await storage.load();
    const entries = listBirthdays(store);

    const result: RemoveTickResult = {
      attempted: entries.map((entry) => entry.userId),
      removed: [],
      skippedNoRole: [],
      failed: [],
    };

    for (const entry of entries) {
      const member = deps.fetchMember ? await deps.fetchMember(entry.userId) : null;

      if (!member) {
        continue;
      }

      if (!member.roles.cache.has(config.roleId)) {
        result.skippedNoRole.push(entry.userId);
        continue;
      }

      try {
        await member.roles.remove(config.roleId);
        result.removed.push(entry.userId);
      } catch {
        result.failed.push(entry.userId);
      }
    }

    return result;
  }

  return {
    setBirthday: setBirthdayFor,
    removeBirthday: removeBirthdayFor,
    runAssignTick,
    runRemoveTick,
  };
}

function createNoopHandler(): BirthdayRoleHandler {
  return {
    setBirthday: async () => ({ ok: false, reason: "invalid-date" }),
    removeBirthday: async () => ({ removed: false }),
    runAssignTick: async () => ({
      attempted: [],
      granted: [],
      skippedAlreadyHadRole: [],
      failed: [],
      announcedTo: null,
    }),
    runRemoveTick: async () => ({
      attempted: [],
      removed: [],
      skippedNoRole: [],
      failed: [],
    }),
  };
}

function pad(value: number, width: number): string {
  return value.toString().padStart(width, "0");
}

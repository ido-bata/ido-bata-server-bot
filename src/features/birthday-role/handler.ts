// Business logic for the birthday-role feature. All Discord-side effects
// (role assignments, channel messages) are funneled through DI seams so
// tests can exercise the logic without a live Client.

import type { ConsentScope } from "../../consent/scopes.js";
import { childFor, getRootLogger } from "../../lib/logger/index.js";
import { type BirthdayRoleConfig, isBirthdayRoleConfigured } from "./config.js";
import { type JstDate, parseBirthdayDate } from "./date.js";
import { selectBirthdaysOnDate } from "./schedule.js";
import {
  type BirthdayEntry,
  type BirthdayStorage,
  createFileBirthdayStorage,
  listBirthdays,
  removeBirthday,
  setBirthday,
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

const logger = childFor(getRootLogger(), "birthday-role-handler");

/**
 * Consent gate used by `setBirthday`. Fail-closed: any `{ ok: false }` from
 * `authorize` is treated as a no-op (returns a `consent-denied` reason to
 * the caller so the slash command can render a friendly message).
 */
export type BirthdayConsentAuthorization = {
  authorize: (subjectId: string, scope: ConsentScope) => Promise<{ ok: boolean }>;
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
  // Optional v0.2.0 consent gate. When provided, `setBirthday` refuses to
  // persist without an active `profile` grant.
  consent?: BirthdayConsentAuthorization;
};

export type BirthdayRoleHandler = {
  setBirthday: (
    userId: string,
    dateInput: string,
  ) => Promise<
    | { ok: true; entry: BirthdayEntry }
    | { ok: false; reason: "invalid-date" | "storage-failed" | "consent-denied" }
  >;
  removeBirthday: (userId: string) => Promise<{ removed: boolean }>;
  runAssignTick: (target: JstDate) => Promise<AssignTickResult>;
  runRemoveTick: (target: JstDate) => Promise<RemoveTickResult>;
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

    // v0.2.0: birthday is a `profile` consent-gated consumer. The gate
    // runs BEFORE we touch storage so a denied user never reaches disk.
    if (deps.consent) {
      const decision = await deps.consent.authorize(userId, "profile");
      if (!decision.ok) {
        return { ok: false as const, reason: "consent-denied" as const };
      }
    }

    const canonical = `${pad(parsed.year, 4)}-${pad(parsed.month, 2)}-${pad(parsed.day, 2)}`;

    try {
      const store = await storage.load();
      const next = setBirthday(store, userId, canonical, now());
      const saved = await storage.save(next);
      if (!saved.ok) {
        logger.warn(
          { userId, error: saved.error },
          "birthday-role: failed to persist registration",
        );
        return { ok: false as const, reason: "storage-failed" as const };
      }
    } catch (error) {
      logger.warn(
        { userId, err: error },
        "birthday-role: unexpected storage error during registration",
      );
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
    const saved = await storage.save(next);
    if (!saved.ok) {
      logger.warn(
        { userId, error: saved.error },
        "birthday-role: failed to persist removal",
      );
      return { removed: false };
    }
    return { removed: true };
  }

  async function runAssignTick(target: JstDate): Promise<AssignTickResult> {
    const store = await storage.load();
    const todays = selectBirthdaysOnDate(listBirthdays(store), target, parseBirthdayDate)
      .map((userId) => store.birthdays[userId])
      .filter((entry): entry is BirthdayEntry => entry !== undefined);

    // v0.2.0: birthday is a `profile` consent-gated consumer. Refuse to
    // apply the role for users who have revoked (or never granted) consent
    // — the persisted registry is just a hint, the consent gate is the
    // authorization decision.
    const consented: BirthdayEntry[] = [];
    const revoked: string[] = [];
    for (const entry of todays) {
      if (deps.consent) {
        const decision = await deps.consent.authorize(entry.userId, "profile");
        if (!decision.ok) {
          revoked.push(entry.userId);
          continue;
        }
      }
      consented.push(entry);
    }

    const result: AssignTickResult = {
      attempted: consented.map((entry) => entry.userId),
      granted: [],
      skippedAlreadyHadRole: [],
      failed: [],
      announcedTo: null,
    };

    for (const entry of consented) {
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

    if (
      result.granted.length > 0 &&
      deps.fetchAnnouncementChannel &&
      config.announcementChannelId
    ) {
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

    // Surface a soft signal when revocations caused us to skip members so
    // operators can audit the registry. Empty array when nobody was
    // revoked (the common case).
    if (revoked.length > 0) {
      logger.warn(
        { skipped: revoked },
        "birthday-role: skipped revoked member(s) during assign tick",
      );
    }

    return result;
  }

  async function runRemoveTick(target: JstDate): Promise<RemoveTickResult> {
    const store = await storage.load();
    const targets = selectBirthdaysOnDate(listBirthdays(store), target, parseBirthdayDate)
      .map((userId) => store.birthdays[userId])
      .filter((entry): entry is BirthdayEntry => entry !== undefined);

    // v0.2.0: the role-strip pass must also honour consent — stripping
    // the role from a member who never granted `profile` would re-introduce
    // the bypass we just closed on the assign side. Skipping on no-grant
    // is safe (no role assigned either).
    const consented: BirthdayEntry[] = [];
    for (const entry of targets) {
      if (deps.consent) {
        const decision = await deps.consent.authorize(entry.userId, "profile");
        if (!decision.ok) {
          continue;
        }
      }
      consented.push(entry);
    }

    const result: RemoveTickResult = {
      attempted: consented.map((entry) => entry.userId),
      removed: [],
      skippedNoRole: [],
      failed: [],
    };

    for (const entry of consented) {
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

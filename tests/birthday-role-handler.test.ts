import { describe, expect, it, vi } from "vitest";

import type { BirthdayRoleConfig } from "../src/features/birthday-role/config.js";
import {
  createBirthdayRoleHandler,
  type HandlerDependencies,
} from "../src/features/birthday-role/handler.js";
import {
  type BirthdayStorage,
  createInMemoryBirthdayStorage,
  setBirthday,
} from "../src/features/birthday-role/storage.js";

const ROLE_ID = "role-birthday";
const GUILD_ID = "guild-birthday";

function makeConfig(): BirthdayRoleConfig {
  return {
    guildId: GUILD_ID,
    roleId: ROLE_ID,
    announcementChannelId: "channel-birthday-announce",
    dataFile: "ignored-for-tests",
  };
}

type FakeMember = {
  id: string;
  roles: {
    cache: { has: ReturnType<typeof vi.fn> };
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
};

function makeMember(id: string, existingRoles: string[] = []): FakeMember {
  return {
    id,
    roles: {
      cache: { has: vi.fn((roleId: string) => existingRoles.includes(roleId)) },
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
  };
}

type FakeChannel = {
  send: ReturnType<typeof vi.fn>;
};

function makeChannel(): FakeChannel {
  return { send: vi.fn(async () => undefined) };
}

describe("birthday-role handler", () => {
  describe("setBirthday", () => {
    it("persists a canonicalized birthday date", async () => {
      const storage = createInMemoryBirthdayStorage();
      const handler = createBirthdayRoleHandler({
        config: makeConfig(),
        storage,
        now: () => new Date("2026-04-01T00:00:00Z"),
      });

      const result = await handler.setBirthday("user-1", "1990-04-02");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.entry.date).toBe("1990-04-02");

      const store = await storage.load();
      expect(store.birthdays["user-1"]?.date).toBe("1990-04-02");
    });

    it("rejects malformed dates", async () => {
      const handler = createBirthdayRoleHandler({
        config: makeConfig(),
        storage: createInMemoryBirthdayStorage(),
      });

      const result = await handler.setBirthday("user-1", "not-a-date");

      expect(result).toEqual({ ok: false, reason: "invalid-date" });
    });

    it("rejects leap-year-incompatible dates", async () => {
      const handler = createBirthdayRoleHandler({
        config: makeConfig(),
        storage: createInMemoryBirthdayStorage(),
      });

      const result = await handler.setBirthday("user-1", "2026-02-29");

      expect(result).toEqual({ ok: false, reason: "invalid-date" });
    });
  });

  describe("removeBirthday", () => {
    it("removes an existing registration", async () => {
      const initialStore = setBirthday(
        { birthdays: {} },
        "user-1",
        "1990-04-02",
        new Date("2026-04-01T00:00:00Z"),
      );
      const handler = createBirthdayRoleHandler({
        config: makeConfig(),
        storage: createInMemoryBirthdayStorage(initialStore),
      });

      const result = await handler.removeBirthday("user-1");

      expect(result).toEqual({ removed: true });
    });

    it("returns removed:false when the user has no registration", async () => {
      const handler = createBirthdayRoleHandler({
        config: makeConfig(),
        storage: createInMemoryBirthdayStorage(),
      });

      const result = await handler.removeBirthday("ghost");

      expect(result).toEqual({ removed: false });
    });
  });

  describe("runAssignTick", () => {
    it("assigns the role to members whose birthday matches the target", async () => {
      const storage: BirthdayStorage = createInMemoryBirthdayStorage({
        birthdays: {
          "user-1": {
            userId: "user-1",
            date: "1990-04-02",
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
          "user-2": {
            userId: "user-2",
            date: "1985-12-31",
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
        },
      });
      const member = makeMember("user-1");
      const channel = makeChannel();

      const deps: HandlerDependencies = {
        config: makeConfig(),
        storage,
        fetchMember: ((id: string) => Promise.resolve(id === "user-1" ? member : null)) as never,
        fetchAnnouncementChannel: (() => Promise.resolve(channel)) as never,
      };

      const handler = createBirthdayRoleHandler(deps);

      const result = await handler.runAssignTick({ year: 2026, month: 4, day: 2 });

      expect(result.granted).toEqual(["user-1"]);
      expect(result.skippedAlreadyHadRole).toEqual([]);
      expect(member.roles.add).toHaveBeenCalledWith(ROLE_ID);
      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(channel.send.mock.calls[0]?.[0]).toContain("<@user-1>");
    });

    it("skips members who already hold the role", async () => {
      const storage: BirthdayStorage = createInMemoryBirthdayStorage({
        birthdays: {
          "user-1": {
            userId: "user-1",
            date: "1990-04-02",
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
        },
      });
      const member = makeMember("user-1", [ROLE_ID]);
      const channel = makeChannel();

      const handler = createBirthdayRoleHandler({
        config: makeConfig(),
        storage,
        fetchMember: (async () => member) as never,
        fetchAnnouncementChannel: (async () => channel) as never,
      });

      const result = await handler.runAssignTick({ year: 2026, month: 4, day: 2 });

      expect(result.granted).toEqual([]);
      expect(result.skippedAlreadyHadRole).toEqual(["user-1"]);
      expect(member.roles.add).not.toHaveBeenCalled();
      expect(channel.send).not.toHaveBeenCalled();
    });

    it("records failures without throwing", async () => {
      const storage: BirthdayStorage = createInMemoryBirthdayStorage({
        birthdays: {
          "user-1": {
            userId: "user-1",
            date: "1990-04-02",
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
        },
      });
      const failingMember: FakeMember = {
        id: "user-1",
        roles: {
          cache: { has: vi.fn(() => false) },
          add: vi.fn(async () => {
            throw new Error("discord down");
          }),
          remove: vi.fn(async () => undefined),
        },
      };
      const handler = createBirthdayRoleHandler({
        config: makeConfig(),
        storage,
        fetchMember: (async () => failingMember) as never,
        fetchAnnouncementChannel: (async () => makeChannel()) as never,
      });

      const result = await handler.runAssignTick({ year: 2026, month: 4, day: 2 });

      expect(result.failed).toEqual(["user-1"]);
      expect(result.granted).toEqual([]);
    });

    it("does nothing when roleId is not configured", async () => {
      const handler = createBirthdayRoleHandler({
        config: { guildId: "", roleId: "", announcementChannelId: "", dataFile: "unused" },
      });

      const result = await handler.runAssignTick({ year: 2026, month: 4, day: 2 });
      expect(result.granted).toEqual([]);
      expect(result.attempted).toEqual([]);
    });
  });

  describe("runRemoveTick", () => {
    it("removes the role from members whose birthday matches the target", async () => {
      const storage: BirthdayStorage = createInMemoryBirthdayStorage({
        birthdays: {
          "user-1": {
            userId: "user-1",
            date: "1990-04-02",
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
          "user-2": {
            userId: "user-2",
            date: "1985-04-02",
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
          "user-3": {
            userId: "user-3",
            date: "2000-07-15",
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
        },
      });
      const withRole = makeMember("user-1", [ROLE_ID]);
      const withoutRole = makeMember("user-2", []);
      const noMatch = makeMember("user-3", [ROLE_ID]);

      const handler = createBirthdayRoleHandler({
        config: makeConfig(),
        storage,
        fetchMember: ((id: string) => {
          if (id === "user-1") return Promise.resolve(withRole);
          if (id === "user-2") return Promise.resolve(withoutRole);
          if (id === "user-3") return Promise.resolve(noMatch);
          return Promise.resolve(null);
        }) as never,
      });

      const result = await handler.runRemoveTick({ year: 2026, month: 4, day: 2 });

      expect(result.attempted).toEqual(["user-1", "user-2"]);
      expect(result.removed).toEqual(["user-1"]);
      expect(result.skippedNoRole).toEqual(["user-2"]);
      expect(withRole.roles.remove).toHaveBeenCalledWith(ROLE_ID);
      expect(withoutRole.roles.remove).not.toHaveBeenCalled();
      expect(noMatch.roles.remove).not.toHaveBeenCalled();
    });
  });
});

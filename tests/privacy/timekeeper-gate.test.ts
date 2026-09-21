import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetTimekeeperPersistenceState,
  attachPersistenceAuthorization,
  createSessionEngagement,
  isRevokedForTesting,
  type PersistenceAuthorization,
  persistSessionAttendance,
  recordAttendance,
} from "../../src/features/timekeeper/engagement.js";

function permitAuth(): PersistenceAuthorization {
  return { authorize: async () => ({ ok: true }) };
}

function denyAuth(): PersistenceAuthorization {
  return { authorize: async () => ({ ok: false }) };
}

describe("timekeeper consent gate", () => {
  let dir: string;
  let cleanup: () => void;
  let detach: () => void = () => undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "timekeeper-gate-"));
    cleanup = () => rmSync(dir, { recursive: true, force: true });
    process.chdir(dir);
    __resetTimekeeperPersistenceState();
  });

  afterEach(() => {
    detach();
    __resetTimekeeperPersistenceState();
    cleanup();
  });

  it("does not persist attendance when authorize returns ok:false", async () => {
    detach = attachPersistenceAuthorization(denyAuth(), () => () => undefined);

    const session = createSessionEngagement("session-1");
    await recordAttendance(session, "user-1", "2026-04-01");

    // In-memory map is gated; nothing should land.
    expect(session.attendanceDatesByUserId.has("user-1")).toBe(false);
  });

  it("persists attendance when authorize returns ok:true", async () => {
    detach = attachPersistenceAuthorization(permitAuth(), () => () => undefined);

    const session = createSessionEngagement("session-1");
    await recordAttendance(session, "user-1", "2026-04-01");

    expect(session.attendanceDatesByUserId.get("user-1")?.has("2026-04-01")).toBe(true);
  });

  it("skips persistence when there is no auth wired (fail-closed)", async () => {
    // Intentionally NOT calling attachPersistenceAuthorization.
    const session = createSessionEngagement("session-1");
    await recordAttendance(session, "user-1", "2026-04-01");
    expect(session.attendanceDatesByUserId.has("user-1")).toBe(false);
  });

  it("subscribes to revoke events and disables future persistence", async () => {
    // Capture the listener through a mutable wrapper so we can fire the
    // `kind === "revoke"` branch from outside `attachPersistenceAuthorization`.
    const captured: { listener: ((event: { kind?: string; subjectId?: string }) => void) | null } =
      {
        listener: null,
      };
    detach = attachPersistenceAuthorization(permitAuth(), (listener) => {
      captured.listener = listener as unknown as (event: {
        kind?: string;
        subjectId?: string;
      }) => void;
      return () => undefined;
    });

    const session = createSessionEngagement("session-1");
    await recordAttendance(session, "user-1", "2026-04-01");
    expect(session.attendanceDatesByUserId.has("user-1")).toBe(true);

    // Emit a revoke event for the same user. The persistence layer only
    // inspects `event.kind === "revoke"` and `event.subjectId`, so the
    // remaining fields are irrelevant to this assertion.
    const fire = captured.listener;
    if (!fire) {
      throw new Error("subscribe never invoked the test listener");
    }
    fire({ kind: "revoke", subjectId: "user-1" });
    expect(isRevokedForTesting("user-1")).toBe(true);

    await recordAttendance(session, "user-1", "2026-04-02");
    // The second attendance was added to the in-memory map only via the
    // permit-all path; persistence itself was skipped because of the
    // revoke flag. We assert via the persist path:
    await persistSessionAttendance(session, "2026-04-02");
    const raw = await import("node:fs").then((fs) =>
      fs.promises.readFile(join(dir, "data", "timekeeper-history.json"), "utf8"),
    );
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    expect(parsed["user-1"]).toEqual(["2026-04-01"]);
  });

  it("persistSessionAttendance writes only the authorized subset", async () => {
    detach = attachPersistenceAuthorization(
      {
        authorize: async (subjectId) => ({ ok: subjectId === "user-1" }),
      },
      () => () => undefined,
    );

    const session = createSessionEngagement("session-1");
    session.checkInsByUserId.set("user-1", new Set([2]));
    session.checkInsByUserId.set("user-2", new Set([2]));

    await persistSessionAttendance(session, "2026-04-01");

    const raw = await import("node:fs").then((fs) =>
      fs.promises.readFile(join(dir, "data", "timekeeper-history.json"), "utf8"),
    );
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    expect(parsed["user-1"]).toEqual(["2026-04-01"]);
    expect(parsed["user-2"]).toBeUndefined();
  });

  it("persistSessionAttendance is a no-op without an auth wired", async () => {
    // No attachPersistenceAuthorization.
    const session = createSessionEngagement("session-1");
    session.checkInsByUserId.set("user-1", new Set([2]));
    await persistSessionAttendance(session, "2026-04-01");
    const exists = await import("node:fs").then((fs) =>
      fs.promises
        .access(join(dir, "data", "timekeeper-history.json"))
        .then(() => true)
        .catch(() => false),
    );
    expect(exists).toBe(false);
  });
});

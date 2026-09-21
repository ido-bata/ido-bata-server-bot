import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { createJsonConsentRepository } from "../../src/consent/repository-json.js";
import { createConsentService } from "../../src/consent/service.js";
import type { ConsentEvent } from "../../src/consent/types.js";

function makeTempDir(): { filePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "consent-service-"));
  const filePath = join(dir, "consent.json");
  return {
    filePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function sourceFixture() {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "message-1",
    emoji: "✅",
  };
}

describe("consent service", () => {
  it("grants a scope and returns it via authorize", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      const repository = createJsonConsentRepository({ filePath });
      const service = createConsentService({
        repository,
        policyVersion: "v0.2.0",
        emojiToScope: new Map([["✅", "profile"]]),
      });
      await service.grant({
        subjectId: "user-1",
        scope: "profile",
        source: sourceFixture(),
      });
      const decision = await service.authorize("user-1", "profile");
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.policyVersion).toBe("v0.2.0");
      }
    } finally {
      cleanup();
    }
  });

  it("revokes an active grant and authorize returns no-grant", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      const repository = createJsonConsentRepository({ filePath });
      const service = createConsentService({
        repository,
        policyVersion: "v0.2.0",
        emojiToScope: new Map([["✅", "profile"]]),
      });
      await service.grant({
        subjectId: "user-1",
        scope: "profile",
        source: sourceFixture(),
      });
      await service.revoke("user-1", "profile");
      const decision = await service.authorize("user-1", "profile");
      expect(decision).toEqual({ ok: false, reason: "no-grant" });
    } finally {
      cleanup();
    }
  });

  it("treats a second revoke as a no-op (idempotent)", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      const repository = createJsonConsentRepository({ filePath });
      const service = createConsentService({
        repository,
        policyVersion: "v0.2.0",
        emojiToScope: new Map([["✅", "profile"]]),
      });
      await service.grant({
        subjectId: "user-1",
        scope: "profile",
        source: sourceFixture(),
      });
      await service.revoke("user-1", "profile");
      // Should not throw.
      await service.revoke("user-1", "profile");
      const list = await service.list("user-1");
      expect(list).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("returns service-unavailable when authorize cannot load the repository", async () => {
    const repository = {
      load: async () => {
        throw new Error("disk full");
      },
      save: async () => undefined,
      upsert: async () => undefined,
      remove: async () => undefined,
      clearSubject: async () => undefined,
    };
    const service = createConsentService({
      repository,
      policyVersion: "v0.2.0",
      emojiToScope: new Map([["✅", "profile"]]),
    });
    const decision = await service.authorize("user-1", "profile");
    expect(decision).toEqual({ ok: false, reason: "service-unavailable" });
  });

  it("returns no-grant when authorize has no record for the subject", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      const repository = createJsonConsentRepository({ filePath });
      const service = createConsentService({
        repository,
        policyVersion: "v0.2.0",
        emojiToScope: new Map([["✅", "profile"]]),
      });
      const decision = await service.authorize("user-1", "profile");
      expect(decision).toEqual({ ok: false, reason: "no-grant" });
    } finally {
      cleanup();
    }
  });

  it("returns wrong-policy when the stored grant is for a stale version", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      const repository = createJsonConsentRepository({ filePath });
      const serviceV0 = createConsentService({
        repository,
        policyVersion: "v0.1.0",
        emojiToScope: new Map([["✅", "profile"]]),
      });
      await serviceV0.grant({
        subjectId: "user-1",
        scope: "profile",
        source: sourceFixture(),
      });
      const serviceV2 = createConsentService({
        repository,
        policyVersion: "v0.2.0",
        emojiToScope: new Map([["✅", "profile"]]),
      });
      const decision = await serviceV2.authorize("user-1", "profile");
      expect(decision).toEqual({ ok: false, reason: "wrong-policy" });
    } finally {
      cleanup();
    }
  });

  it("treats each (subject, scope) pair independently", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      const repository = createJsonConsentRepository({ filePath });
      const service = createConsentService({
        repository,
        policyVersion: "v0.2.0",
        emojiToScope: new Map([
          ["✅", "profile"],
          ["📌", "activity-history"],
        ]),
      });
      await service.grant({
        subjectId: "user-1",
        scope: "profile",
        source: sourceFixture(),
      });
      const activityDecision = await service.authorize("user-1", "activity-history");
      expect(activityDecision).toEqual({ ok: false, reason: "no-grant" });
      const profileDecision = await service.authorize("user-1", "profile");
      expect(profileDecision.ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("emits grant and revoke events to subscribers and ignores listener errors", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      const repository = createJsonConsentRepository({ filePath });
      const service = createConsentService({
        repository,
        policyVersion: "v0.2.0",
        emojiToScope: new Map([["✅", "profile"]]),
      });
      const events: ConsentEvent[] = [];
      service.subscribe((event) => events.push(event));
      // Listener that throws — must not break the service.
      service.subscribe(() => {
        throw new Error("boom");
      });
      await service.grant({
        subjectId: "user-1",
        scope: "profile",
        source: sourceFixture(),
      });
      await service.revoke("user-1", "profile");
      expect(events.map((event) => event.kind)).toEqual(["grant", "revoke"]);
    } finally {
      cleanup();
    }
  });

  it("list returns only the active records for the requested subject", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      const repository = createJsonConsentRepository({ filePath });
      const service = createConsentService({
        repository,
        policyVersion: "v0.2.0",
        emojiToScope: new Map([
          ["✅", "profile"],
          ["📌", "activity-history"],
        ]),
      });
      await service.grant({
        subjectId: "user-1",
        scope: "profile",
        source: sourceFixture(),
      });
      await service.grant({
        subjectId: "user-1",
        scope: "activity-history",
        source: sourceFixture(),
      });
      await service.grant({
        subjectId: "user-2",
        scope: "profile",
        source: sourceFixture(),
      });
      await service.revoke("user-1", "activity-history");
      const list = await service.list("user-1");
      expect(list).toHaveLength(1);
      expect(list[0]?.scope).toBe("profile");
    } finally {
      cleanup();
    }
  });

  it("clear emits a clear event when at least one scope succeeds", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      const repository = createJsonConsentRepository({ filePath });
      const service = createConsentService({
        repository,
        policyVersion: "v0.2.0",
        emojiToScope: new Map([
          ["✅", "profile"],
          ["📌", "activity-history"],
        ]),
      });
      await service.grant({
        subjectId: "user-1",
        scope: "profile",
        source: sourceFixture(),
      });
      await service.grant({
        subjectId: "user-1",
        scope: "activity-history",
        source: sourceFixture(),
      });
      const events: ConsentEvent[] = [];
      service.subscribe((event) => events.push(event));
      const report = await service.clear("user-1");
      expect(report.results).toHaveLength(2);
      expect(report.results.every((result) => result.ok)).toBe(true);
      const kinds = events.map((event) => event.kind);
      expect(kinds).toContain("clear");
    } finally {
      cleanup();
    }
  });
});

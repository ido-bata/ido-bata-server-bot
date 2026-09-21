import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createJsonConsentRepository } from "../../src/consent/repository-json.js";
import type { ConsentRecord } from "../../src/consent/types.js";

function makeTempDir(): { filePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "consent-repo-"));
  const filePath = join(dir, "consent.json");
  return {
    filePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeRecord(overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    subjectId: "user-1",
    scope: "profile",
    policyVersion: "v0.2.0",
    grantedAt: "2025-01-01T00:00:00.000Z",
    revokedAt: null,
    source: {
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
      emoji: "✅",
    },
    ...overrides,
  };
}

describe("JSON consent repository", () => {
  it("returns an empty list when the file does not exist", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      const repository = createJsonConsentRepository({ filePath });
      const records = await repository.load();
      expect(records).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("round-trips records via save → load", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      const repository = createJsonConsentRepository({ filePath });
      const records = [
        makeRecord(),
        makeRecord({ subjectId: "user-2", scope: "activity-history" }),
      ];
      await repository.save(records);
      const loaded = await repository.load();
      expect(loaded).toEqual(records);
    } finally {
      cleanup();
    }
  });

  it("treats corrupt JSON as an empty store without throwing", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      writeFileSync(filePath, "{not valid json", "utf8");
      const repository = createJsonConsentRepository({ filePath });
      const records = await repository.load();
      expect(records).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("treats a missing file as an empty store and persists the schema version on next save", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      const repository = createJsonConsentRepository({ filePath });
      await repository.save([makeRecord()]);
      const raw = readFileSync(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      expect(parsed).toMatchObject({ schemaVersion: 1 });
    } finally {
      cleanup();
    }
  });

  it("upsert replaces an existing (subjectId, scope) record", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      const repository = createJsonConsentRepository({ filePath });
      const initial = makeRecord({ grantedAt: "2025-01-01T00:00:00.000Z" });
      await repository.upsert(initial);
      const updated = makeRecord({ grantedAt: "2025-06-01T00:00:00.000Z" });
      await repository.upsert(updated);
      const loaded = await repository.load();
      expect(loaded).toEqual([updated]);
    } finally {
      cleanup();
    }
  });

  it("remove deletes only the matching (subjectId, scope) pair", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      const repository = createJsonConsentRepository({ filePath });
      await repository.upsert(makeRecord({ subjectId: "user-1", scope: "profile" }));
      await repository.upsert(makeRecord({ subjectId: "user-1", scope: "activity-history" }));
      await repository.remove("user-1", "profile");
      const loaded = await repository.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.scope).toBe("activity-history");
    } finally {
      cleanup();
    }
  });

  it("clearSubject removes every record for the subject across all scopes", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      const repository = createJsonConsentRepository({ filePath });
      await repository.upsert(makeRecord({ subjectId: "user-1", scope: "profile" }));
      await repository.upsert(makeRecord({ subjectId: "user-1", scope: "activity-history" }));
      await repository.upsert(makeRecord({ subjectId: "user-2", scope: "profile" }));
      await repository.clearSubject("user-1");
      const loaded = await repository.load();
      expect(loaded).toEqual([makeRecord({ subjectId: "user-2", scope: "profile" })]);
    } finally {
      cleanup();
    }
  });
});

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
      const removed = await repository.remove("user-1", "profile");
      expect(removed).toBe(true);
      const loaded = await repository.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.scope).toBe("activity-history");
      // Second remove on the now-absent pair returns false.
      const removedAgain = await repository.remove("user-1", "profile");
      expect(removedAgain).toBe(false);
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

  it("preserves unrecognised bytes via a timestamped backup and refuses subsequent writes", async () => {
    const { filePath, cleanup } = makeTempDir();
    try {
      // Bump the schema version to something the current schema does not
      // recognise. The original bytes must survive via a backup file and
      // a follow-up write must throw instead of clobbering them.
      writeFileSync(
        filePath,
        JSON.stringify({ schemaVersion: 999, records: [{ legacy: true }] }, null, 2),
        "utf8",
      );
      const repository = createJsonConsentRepository({ filePath });
      const loaded = await repository.load();
      expect(loaded).toEqual([]);
      // Original file has been renamed to a `.unrecognised-<ts>.bak`.
      const dirEntries = readdirSync(dirname(filePath));
      expect(
        dirEntries.some((name) => name.includes(".unrecognised-") && name.endsWith(".bak")),
      ).toBe(true);
      // Subsequent writes refuse to clobber the (now-missing) original
      // until the operator has inspected the backup and removed the
      // recognised=false state by writing a recognised file themselves.
      await expect(repository.upsert(makeRecord())).rejects.toThrow(/refusing to persist/);
    } finally {
      cleanup();
    }
  });
});

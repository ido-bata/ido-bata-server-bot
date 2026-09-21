import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJsonConsentRepository } from "../../src/consent/repository-json.js";
import { createConsentService } from "../../src/consent/service.js";
import type { ReactionTarget } from "../../src/consent/types.js";

function makeTempDir(): { filePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "consent-reconcile-"));
  const filePath = join(dir, "consent.json");
  return {
    filePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const TARGETS: ReactionTarget[] = [
  {
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "message-1",
    emoji: "✅",
  },
];

describe("consent reconciliation", () => {
  let cleanup: () => void;
  let filePath: string;

  beforeEach(() => {
    const ctx = makeTempDir();
    cleanup = ctx.cleanup;
    filePath = ctx.filePath;
  });

  afterEach(() => {
    cleanup();
  });

  it("applies grants for every user returned by the fetcher", async () => {
    const repository = createJsonConsentRepository({ filePath });
    const fetcher = {
      fetchMessageReactions: vi.fn(async () => new Set(["user-1", "user-2"])),
    };
    const service = createConsentService({
      repository,
      fetcher,
      policyVersion: "v0.2.0",
      emojiToScope: new Map([["✅", "profile"]]),
    });
    const report = await service.reconcile(TARGETS);
    expect(report.appliedGrants).toHaveLength(2);
    expect(report.appliedRevokes).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(fetcher.fetchMessageReactions).toHaveBeenCalledTimes(1);
    const list1 = await service.list("user-1");
    const list2 = await service.list("user-2");
    expect(list1[0]?.scope).toBe("profile");
    expect(list2[0]?.scope).toBe("profile");
  });

  it("applies revokes for users no longer in the reaction set", async () => {
    const repository = createJsonConsentRepository({ filePath });
    const service = createConsentService({
      repository,
      policyVersion: "v0.2.0",
      emojiToScope: new Map([["✅", "profile"]]),
    });
    // Seed an existing grant for user-1, and add a stale grant for user-3.
    await service.grant({
      subjectId: "user-1",
      scope: "profile",
      source: TARGETS[0]!,
    });
    await service.grant({
      subjectId: "user-3",
      scope: "profile",
      source: TARGETS[0]!,
    });
    // Fetcher now returns only user-1 and user-2.
    const fetcher = {
      fetchMessageReactions: vi.fn(async () => new Set(["user-1", "user-2"])),
    };
    const reconcileService = createConsentService({
      repository,
      fetcher,
      policyVersion: "v0.2.0",
      emojiToScope: new Map([["✅", "profile"]]),
    });
    const report = await reconcileService.reconcile(TARGETS);
    expect(report.appliedGrants.map((entry) => entry.subjectId).sort()).toEqual(["user-2"]);
    expect(report.appliedRevokes.map((entry) => entry.subjectId)).toEqual(["user-3"]);
    const list1 = await reconcileService.list("user-1");
    const list3 = await reconcileService.list("user-3");
    expect(list1).toHaveLength(1);
    expect(list3).toEqual([]);
  });

  it("does not auto-grant when the fetcher throws — pushes to failures[]", async () => {
    const repository = createJsonConsentRepository({ filePath });
    const fetcher = {
      fetchMessageReactions: vi.fn(async () => {
        throw new Error("discord api 500");
      }),
    };
    const service = createConsentService({
      repository,
      fetcher,
      policyVersion: "v0.2.0",
      emojiToScope: new Map([["✅", "profile"]]),
    });
    const report = await service.reconcile(TARGETS);
    expect(report.appliedGrants).toEqual([]);
    expect(report.appliedRevokes).toEqual([]);
    expect(report.failures).toEqual(["guild-1"]);
    const all = await service.list("user-anything");
    expect(all).toEqual([]);
  });

  it("returns an empty report when given no targets", async () => {
    const repository = createJsonConsentRepository({ filePath });
    const fetcher = {
      fetchMessageReactions: vi.fn(async () => new Set(["user-1"])),
    };
    const service = createConsentService({
      repository,
      fetcher,
      policyVersion: "v0.2.0",
      emojiToScope: new Map([["✅", "profile"]]),
    });
    const report = await service.reconcile([]);
    expect(report).toEqual({ appliedGrants: [], appliedRevokes: [], failures: [] });
    expect(fetcher.fetchMessageReactions).not.toHaveBeenCalled();
  });

  it("skips targets whose emoji is not in emojiToScope", async () => {
    const repository = createJsonConsentRepository({ filePath });
    const fetcher = {
      fetchMessageReactions: vi.fn(async () => new Set(["user-1"])),
    };
    const service = createConsentService({
      repository,
      fetcher,
      policyVersion: "v0.2.0",
      emojiToScope: new Map([["📌", "activity-history"]]),
    });
    const report = await service.reconcile(TARGETS);
    expect(report.appliedGrants).toEqual([]);
    expect(report.failures).toContain("guild-1");
  });

  it("returns the standard report shape", async () => {
    const repository = createJsonConsentRepository({ filePath });
    const fetcher = {
      fetchMessageReactions: vi.fn(async () => new Set<string>()),
    };
    const service = createConsentService({
      repository,
      fetcher,
      policyVersion: "v0.2.0",
      emojiToScope: new Map([["✅", "profile"]]),
    });
    const report = await service.reconcile(TARGETS);
    expect(Object.keys(report).sort()).toEqual(["appliedGrants", "appliedRevokes", "failures"]);
  });
});

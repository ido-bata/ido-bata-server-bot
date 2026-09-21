import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createReactionHandler } from "../../src/consent/reaction-handler.js";
import { createJsonConsentRepository } from "../../src/consent/repository-json.js";
import { createConsentService } from "../../src/consent/service.js";
import type { ConsentEvent } from "../../src/consent/types.js";

function makeTempDir(): { filePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "consent-handler-"));
  const filePath = join(dir, "consent.json");
  return {
    filePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const TARGET = {
  guildId: "guild-1",
  channelId: "channel-1",
  messageId: "message-1",
  emoji: "✅",
};

describe("consent reaction handler", () => {
  let cleanup: () => void;
  let service: ReturnType<typeof createConsentService>;
  let events: ConsentEvent[];

  beforeEach(() => {
    const ctx = makeTempDir();
    cleanup = ctx.cleanup;
    const repository = createJsonConsentRepository({ filePath: ctx.filePath });
    service = createConsentService({
      repository,
      policyVersion: "v0.2.0",
      emojiToScope: new Map([["✅", "profile"]]),
    });
    events = [];
    service.subscribe((event) => events.push(event));
  });

  afterEach(() => {
    cleanup();
  });

  it("grants consent on a matching reaction add", async () => {
    const handler = createReactionHandler({
      fetcher: { fetchMessageReactions: async () => new Set<string>() },
      service,
      targets: [TARGET],
      emojiToScope: new Map([["✅", "profile"]]),
    });
    await handler.onAdd("message-1", "channel-1", "guild-1", "user-1", "✅", false);
    const list = await service.list("user-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.scope).toBe("profile");
    expect(events.map((event) => event.kind)).toEqual(["grant"]);
  });

  it("revokes consent on a matching reaction remove", async () => {
    await service.grant({
      subjectId: "user-1",
      scope: "profile",
      source: TARGET,
    });
    const handler = createReactionHandler({
      fetcher: { fetchMessageReactions: async () => new Set<string>() },
      service,
      targets: [TARGET],
      emojiToScope: new Map([["✅", "profile"]]),
    });
    await handler.onRemove("message-1", "channel-1", "guild-1", "user-1", "✅", false);
    const list = await service.list("user-1");
    expect(list).toEqual([]);
    expect(events.map((event) => event.kind)).toContain("revoke");
  });

  it("ignores reactions from the bot user", async () => {
    const handler = createReactionHandler({
      fetcher: { fetchMessageReactions: async () => new Set<string>() },
      service,
      targets: [TARGET],
      emojiToScope: new Map([["✅", "profile"]]),
    });
    await handler.onAdd("message-1", "channel-1", "guild-1", "user-bot", "✅", true);
    const list = await service.list("user-bot");
    expect(list).toEqual([]);
    expect(events).toEqual([]);
  });

  it("is a no-op for reactions on non-consent messages", async () => {
    const handler = createReactionHandler({
      fetcher: { fetchMessageReactions: async () => new Set<string>() },
      service,
      targets: [TARGET],
      emojiToScope: new Map([["✅", "profile"]]),
    });
    await handler.onAdd("message-2", "channel-1", "guild-1", "user-1", "✅", false);
    const list = await service.list("user-1");
    expect(list).toEqual([]);
    expect(events).toEqual([]);
  });

  it("maps multiple emojis to multiple scopes", async () => {
    const targets = [
      { ...TARGET, emoji: "✅" },
      { ...TARGET, emoji: "📌" },
    ];
    const handler = createReactionHandler({
      fetcher: { fetchMessageReactions: async () => new Set<string>() },
      service,
      targets,
      emojiToScope: new Map([
        ["✅", "profile"],
        ["📌", "activity-history"],
      ]),
    });
    await handler.onAdd("message-1", "channel-1", "guild-1", "user-1", "✅", false);
    await handler.onAdd("message-1", "channel-1", "guild-1", "user-1", "📌", false);
    const list = await service.list("user-1");
    expect(list).toHaveLength(2);
    const scopes = list.map((record) => record.scope).sort();
    expect(scopes).toEqual(["activity-history", "profile"]);
  });

  it("notifies subscribers when grant/revoke fire", async () => {
    const handler = createReactionHandler({
      fetcher: { fetchMessageReactions: async () => new Set<string>() },
      service,
      targets: [TARGET],
      emojiToScope: new Map([["✅", "profile"]]),
    });
    await handler.onAdd("message-1", "channel-1", "guild-1", "user-1", "✅", false);
    await handler.onRemove("message-1", "channel-1", "guild-1", "user-1", "✅", false);
    expect(events.map((event) => event.kind)).toEqual(["grant", "revoke"]);
  });
});
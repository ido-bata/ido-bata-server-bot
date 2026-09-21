import { type Client, Collection, type Message, type User } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { ConsentConfig } from "../../src/consent/config.js";
import {
  CONSENT_MESSAGE_MARKER,
  createDiscordReactionFetcher,
  ensureConsentMessage,
  renderConsentMessage,
} from "../../src/consent/message-bootstrap.js";

const baseConfig: ConsentConfig = {
  enabled: true,
  messageId: "",
  channelId: "channel-1",
  guildId: "guild-1",
  emojiToScope: {
    "📊": "activity-history",
    "🟢": "presence-history",
    "👤": "profile",
    "💬": "message-history",
  },
  policyVersion: "v0.2.0",
};

function makeMessage(options: { id: string; authorId?: string; content?: string }) {
  const message = {
    id: options.id,
    author: { id: options.authorId ?? "bot-1" },
    content: options.content ?? "",
    edit: vi.fn(async (content: string) => {
      message.content = content;
      return message;
    }),
    react: vi.fn(async () => message),
    reactions: {
      resolve: vi.fn(),
      cache: new Collection(),
    },
  };
  return message;
}

function makeBootstrapHarness(existing: Array<ReturnType<typeof makeMessage>> = []) {
  const recent = new Collection<string, ReturnType<typeof makeMessage>>();
  for (const message of existing) {
    recent.set(message.id, message);
  }
  const created = makeMessage({ id: "created-1", content: "" });
  const fetchMessage = vi.fn(async (arg: string | { limit: number }) => {
    if (typeof arg === "string") {
      const found = recent.get(arg);
      if (!found) {
        throw new Error("Unknown Message");
      }
      return found;
    }
    return recent;
  });
  const send = vi.fn(async (content: string) => {
    created.content = content;
    recent.set(created.id, created);
    return created;
  });
  const channel = {
    guildId: "guild-1",
    isTextBased: () => true,
    messages: { fetch: fetchMessage },
    send,
  };
  const client = {
    user: { id: "bot-1" },
    channels: { fetch: vi.fn(async () => channel) },
  } as unknown as Client;
  return { client, channel, created, send, fetchMessage, recent };
}

describe("consent message bootstrap", () => {
  it("creates a bot-authored managed message and reactions when none exists", async () => {
    const harness = makeBootstrapHarness();

    const resolved = await ensureConsentMessage({
      client: harness.client,
      config: baseConfig,
    });

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.created.content).toContain(CONSENT_MESSAGE_MARKER);
    expect(harness.created.content).toContain("/privacy status");
    expect(harness.created.content).toContain("/privacy delete");
    expect(harness.created.react.mock.calls.map(([emoji]) => emoji)).toEqual([
      "📊",
      "🟢",
      "👤",
      "💬",
    ]);
    expect(resolved.messageId).toBe("created-1");
  });

  it("reuses and updates an existing bot-managed consent message", async () => {
    const existing = makeMessage({
      id: "managed-1",
      content: `old template\n-# ${CONSENT_MESSAGE_MARKER}`,
    });
    const harness = makeBootstrapHarness([existing]);

    const resolved = await ensureConsentMessage({
      client: harness.client,
      config: baseConfig,
    });

    expect(harness.send).not.toHaveBeenCalled();
    expect(existing.edit).toHaveBeenCalledWith(renderConsentMessage(baseConfig));
    expect(existing.react).toHaveBeenCalledTimes(4);
    expect(resolved.messageId).toBe("managed-1");
  });

  it("uses an explicit message override and never creates a replacement", async () => {
    const override = makeMessage({ id: "override-1", authorId: "human-1", content: "custom" });
    const harness = makeBootstrapHarness([override]);

    const resolved = await ensureConsentMessage({
      client: harness.client,
      config: { ...baseConfig, messageId: "override-1" },
    });

    expect(harness.send).not.toHaveBeenCalled();
    expect(override.edit).not.toHaveBeenCalled();
    expect(override.react).toHaveBeenCalledTimes(4);
    expect(resolved.messageId).toBe("override-1");
  });

  it("fails closed when an explicit override cannot be fetched", async () => {
    const harness = makeBootstrapHarness();

    await expect(
      ensureConsentMessage({
        client: harness.client,
        config: { ...baseConfig, messageId: "missing" },
      }),
    ).rejects.toThrow(/refusing to create a replacement/);

    expect(harness.send).not.toHaveBeenCalled();
  });
});

describe("Discord reaction fetcher", () => {
  it("returns human reactors and excludes bot accounts", async () => {
    const users = new Collection<string, User>();
    users.set("user-1", { id: "user-1", bot: false } as User);
    users.set("bot-1", { id: "bot-1", bot: true } as User);

    const reaction = {
      users: {
        fetch: vi.fn(async () => users),
      },
    };
    const message = makeMessage({ id: "message-1" });
    message.reactions.resolve.mockReturnValue(reaction);
    const channel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn(async () => message as unknown as Message),
      },
    };
    const client = {
      channels: { fetch: vi.fn(async () => channel) },
    } as unknown as Client;

    const fetcher = createDiscordReactionFetcher(client);
    const result = await fetcher.fetchMessageReactions({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
      emoji: "📊",
    });

    expect([...result]).toEqual(["user-1"]);
  });
});

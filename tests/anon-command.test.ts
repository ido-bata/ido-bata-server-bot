import { describe, expect, it, vi } from "vitest";
import type { AnonymousChatService } from "../src/features/anonymous-chat/service.js";
import { anonCommand } from "../src/features/slash-commands/commands/anon.js";
import { toApplicationCommandPayload } from "../src/features/slash-commands/deploy.js";

type ReplyOptions = { content: string; ephemeral?: boolean };

function makeInteraction(
  overrides: {
    inGuild?: boolean;
    guildId?: string | null;
    channelId?: string | null;
    message?: string | null;
    getStringThrows?: boolean;
    replyImpl?: () => Promise<unknown>;
  } = {},
) {
  const reply = vi.fn(async (options: ReplyOptions) => {
    void options;
    if (overrides.replyImpl) {
      return overrides.replyImpl();
    }
    return undefined;
  });
  const interaction = {
    inGuild: () => overrides.inGuild ?? true,
    guildId: overrides.guildId === undefined ? "guild-1" : overrides.guildId,
    channelId: overrides.channelId === undefined ? "chan-1" : overrides.channelId,
    user: { id: "user-1" },
    options: {
      getString: () => {
        if (overrides.getStringThrows) {
          throw new Error("option missing");
        }
        return overrides.message === undefined ? "hello" : overrides.message;
      },
    },
    reply,
  };
  return { interaction, reply };
}

function makeService(result: unknown): AnonymousChatService {
  return { post: vi.fn(async () => result) } as unknown as AnonymousChatService;
}

async function run(interaction: ReturnType<typeof makeInteraction>["interaction"], deps?: unknown) {
  await anonCommand.execute({ interaction: interaction as never, commandName: "anon" }, deps);
}

describe("/anon command", () => {
  it("declares the anon payload with a required message option", () => {
    const json = toApplicationCommandPayload(anonCommand.buildPayload());
    expect(json.name).toBe("anon");
    expect(JSON.stringify(json)).toContain('"message"');
  });

  it("replies unavailable when no service is wired", async () => {
    const { interaction, reply } = makeInteraction();
    await run(interaction, {});
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringContaining("利用できません"),
      }),
    );
  });

  it("denies non-guild invocations without calling the service", async () => {
    const service = makeService({ ok: true });
    const { interaction, reply } = makeInteraction({ inGuild: false });
    await run(interaction, { service });
    expect(service.post).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it("posts via the service and replies success ephemerally", async () => {
    const service = makeService({ ok: true });
    const { interaction, reply } = makeInteraction();
    await run(interaction, { service });
    expect(service.post).toHaveBeenCalledWith({
      userId: "user-1",
      guildId: "guild-1",
      channelId: "chan-1",
      message: "hello",
    });
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true, content: "匿名メッセージを投稿しました。" }),
    );
  });

  it("maps service denials to the generic denied reply", async () => {
    const service = makeService({ ok: false, reason: "denied" });
    const { interaction, reply } = makeInteraction();
    await run(interaction, { service });
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "この場所には匿名投稿できません。" }),
    );
  });

  it("maps cooldown with a retry hint", async () => {
    const service = makeService({ ok: false, reason: "cooldown", retryAfterMs: 12_000 });
    const { interaction, reply } = makeInteraction();
    await run(interaction, { service });
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("12") }),
    );
  });

  it("maps bot permission denial to the dedicated reply", async () => {
    const service = makeService({ ok: false, reason: "bot_permission_denied" });
    const { interaction, reply } = makeInteraction();
    await run(interaction, { service });
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("ボット") }),
    );
  });

  it("never throws — option read failure yields a generic ephemeral", async () => {
    const service = makeService({ ok: true });
    const { interaction, reply } = makeInteraction({ getStringThrows: true });
    await expect(run(interaction, { service })).resolves.toBeUndefined();
    expect(service.post).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringContaining("利用できません"),
      }),
    );
  });

  it("never throws — service exceptions yield a generic ephemeral", async () => {
    const service = {
      post: vi.fn(async () => {
        throw new Error("boom user-1 secret-body");
      }),
    } as unknown as AnonymousChatService;
    const { interaction, reply } = makeInteraction();
    await expect(run(interaction, { service })).resolves.toBeUndefined();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringContaining("利用できません"),
      }),
    );
    // The error text must not leak into the reply.
    const content = reply.mock.calls[0]?.[0] as ReplyOptions | undefined;
    expect(content?.content).not.toContain("user-1");
    expect(content?.content).not.toContain("secret-body");
  });

  it("survives a failing reply in the catch path", async () => {
    const service = makeService({ ok: true });
    const { interaction } = makeInteraction({
      replyImpl: async () => {
        throw new Error("interaction expired");
      },
    });
    // getString works; service.post ok → reply throws inside try →
    // catch attempts reply again which also throws → swallowed.
    await expect(run(interaction, { service })).resolves.toBeUndefined();
  });
});

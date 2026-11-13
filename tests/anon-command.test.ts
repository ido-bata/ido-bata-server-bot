import { describe, expect, it, vi } from "vitest";
import type { AnonymousChatService } from "../src/features/anonymous-chat/service.js";
import { anonCommand } from "../src/features/slash-commands/commands/anon.js";
import { toApplicationCommandPayload } from "../src/features/slash-commands/deploy.js";

function makeInteraction(
  overrides: {
    inGuild?: boolean;
    guildId?: string | null;
    channelId?: string | null;
    message?: string | null;
    getStringThrows?: boolean;
    deferThrows?: boolean;
    editReplyImpl?: () => Promise<unknown>;
    replyImpl?: () => Promise<unknown>;
  } = {},
) {
  const deferReply = vi.fn(async () => {
    if (overrides.deferThrows) {
      throw new Error("interaction expired");
    }
    return undefined;
  });
  const editReply = vi.fn(async (options: { content: string }) => {
    void options;
    if (overrides.editReplyImpl) {
      return overrides.editReplyImpl();
    }
    return undefined;
  });
  const reply = vi.fn(async () => {
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
    deferReply,
    editReply,
    reply,
  };
  return { interaction, deferReply, editReply, reply };
}

function makeService(result: unknown): AnonymousChatService {
  return {
    post: vi.fn(async () => result),
    auditState: "disabled",
  } as unknown as AnonymousChatService;
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

  it("defers ephemerally before any work, then edits with the outcome", async () => {
    const service = makeService({ ok: true });
    const { interaction, deferReply, editReply } = makeInteraction();
    await run(interaction, { service });
    expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "匿名メッセージを投稿しました。" }),
    );
  });

  it("replies unavailable via editReply when no service is wired", async () => {
    const { interaction, editReply } = makeInteraction();
    await run(interaction, {});
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("利用できません") }),
    );
  });

  it("denies non-guild invocations without calling the service", async () => {
    const service = makeService({ ok: true });
    const { interaction, editReply } = makeInteraction({ inGuild: false });
    await run(interaction, { service });
    expect(service.post).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.any(String) }),
    );
  });

  it("posts via the service and edits success", async () => {
    const service = makeService({ ok: true });
    const { interaction, editReply } = makeInteraction();
    await run(interaction, { service });
    expect(service.post).toHaveBeenCalledWith({
      userId: "user-1",
      guildId: "guild-1",
      channelId: "chan-1",
      message: "hello",
    });
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "匿名メッセージを投稿しました。" }),
    );
  });

  it("maps service denials to the generic denied reply", async () => {
    const service = makeService({ ok: false, reason: "denied" });
    const { interaction, editReply } = makeInteraction();
    await run(interaction, { service });
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "この場所には匿名投稿できません。" }),
    );
  });

  it("maps cooldown with a retry hint", async () => {
    const service = makeService({ ok: false, reason: "cooldown", retryAfterMs: 12_000 });
    const { interaction, editReply } = makeInteraction();
    await run(interaction, { service });
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("12") }),
    );
  });

  it("maps bot permission denial to the generic unavailable reply", async () => {
    const service = makeService({ ok: false, reason: "bot_permission_denied" });
    const { interaction, editReply } = makeInteraction();
    await run(interaction, { service });
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("利用できません") }),
    );
    const content = editReply.mock.calls[0]?.[0] as { content: string } | undefined;
    expect(content?.content).not.toContain("ボット");
  });

  it("never throws — option read failure yields a generic ephemeral edit", async () => {
    const service = makeService({ ok: true });
    const { interaction, editReply } = makeInteraction({ getStringThrows: true });
    await expect(run(interaction, { service })).resolves.toBeUndefined();
    expect(service.post).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("利用できません") }),
    );
  });

  it("never throws — service exceptions yield a generic ephemeral edit", async () => {
    const service = {
      post: vi.fn(async () => {
        throw new Error("boom user-1 secret-body");
      }),
    } as unknown as AnonymousChatService;
    const { interaction, editReply } = makeInteraction();
    await expect(run(interaction, { service })).resolves.toBeUndefined();
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("利用できません") }),
    );
    const content = editReply.mock.calls[0]?.[0] as { content: string } | undefined;
    expect(content?.content).not.toContain("user-1");
    expect(content?.content).not.toContain("secret-body");
  });

  it("does not retry the post when editReply fails after a successful post", async () => {
    const service = makeService({ ok: true });
    const { interaction, editReply } = makeInteraction({
      editReplyImpl: async () => {
        throw new Error("webhook token expired");
      },
    });
    await expect(run(interaction, { service })).resolves.toBeUndefined();
    expect(service.post).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
  });

  it("falls back to a guarded reply when deferReply fails", async () => {
    const service = makeService({ ok: true });
    const { interaction, editReply, reply } = makeInteraction({ deferThrows: true });
    await expect(run(interaction, { service })).resolves.toBeUndefined();
    expect(service.post).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringContaining("利用できません"),
      }),
    );
  });

  it("survives a failing reply fallback when deferReply fails", async () => {
    const { interaction, reply } = makeInteraction({
      deferThrows: true,
      replyImpl: async () => {
        throw new Error("interaction expired");
      },
    });
    await expect(run(interaction, {})).resolves.toBeUndefined();
    expect(reply).toHaveBeenCalled();
  });
});

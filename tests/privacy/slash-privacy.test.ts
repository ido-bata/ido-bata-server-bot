import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConsentService } from "../../src/consent/service.js";
import type {
  handlePrivacyButton as HandlePrivacyButtonFn,
  privacyCommand as PrivacyCommandFn,
} from "../../src/features/slash-commands/commands/privacy.js";
import {
  handlePrivacyButton,
  privacyCommand,
} from "../../src/features/slash-commands/commands/privacy.js";

function makeInteraction(overrides: Record<string, unknown> = {}): {
  user: { id: string };
  isRepliable: () => boolean;
  reply: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  options: { getSubcommand: () => string };
  customId: string;
  __replies: Array<{ content?: string; components?: unknown[]; ephemeral?: boolean }>;
  __updates: Array<{ content?: string; components?: unknown[]; ephemeral?: boolean }>;
} {
  const replies: Array<{ content?: string; components?: unknown[]; ephemeral?: boolean }> = [];
  const updates: Array<{ content?: string; components?: unknown[]; ephemeral?: boolean }> = [];
  return {
    user: { id: "user-1" },
    isRepliable: () => true,
    reply: vi.fn(
      async (opts: { content?: string; components?: unknown[]; ephemeral?: boolean }) => {
        replies.push(opts);
        return undefined;
      },
    ),
    update: vi.fn(
      async (opts: { content?: string; components?: unknown[]; ephemeral?: boolean }) => {
        updates.push(opts);
        return undefined;
      },
    ),
    followUp: vi.fn(async () => undefined),
    options: { getSubcommand: () => "status" },
    customId: "",
    __replies: replies,
    __updates: updates,
    ...overrides,
  };
}

describe("/privacy status", () => {
  it("replies with an ephemeral status message when no ConsentService is wired", async () => {
    const interaction = makeInteraction({ options: { getSubcommand: () => "status" } });
    await privacyCommand.execute({ interaction: interaction as never, commandName: "privacy" });
    expect(interaction.__replies).toHaveLength(1);
    const reply = interaction.__replies[0];
    expect(reply?.ephemeral).toBe(true);
    expect(reply?.content).toContain("Privacy status");
    expect(reply?.content).toContain("保存カテゴリ");
    expect(reply?.content).toContain("consent-gated");
    expect(reply?.content).toContain("operational");
    expect(reply?.content).toContain("ephemeral");
  });

  it("renders active / revoked / notGranted scopes when a service is supplied", async () => {
    const service = createConsentService({
      repository: {
        load: async () => [],
        save: async () => undefined,
        upsert: async () => undefined,
        remove: async () => false,
        clearSubject: async () => undefined,
      },
      policyVersion: "v0.2.0",
      emojiToScope: new Map(),
    });
    await service.grant({
      subjectId: "user-1",
      scope: "profile",
      source: {
        channelId: "channel-1",
        emoji: "x",
        guildId: "guild-1",
        messageId: "message-1",
      },
    });
    const interaction = makeInteraction({ options: { getSubcommand: () => "status" } });
    // The SlashCommandDefinition `execute` signature only declares the
    // context arg, but the privacy command accepts a second `deps` arg at
    // runtime so callers can wire a ConsentService. The handler that
    // dispatches production traffic calls with one arg; tests reach into the
    // 2nd-arg path through `handlePrivacyButton`. Here we cast to keep the
    // test focused on the consent rendering contract.
    type ExecuteWithDeps = (
      ctx: { interaction: unknown; commandName: string },
      deps: { consentService?: typeof service },
    ) => Promise<unknown>;
    await (privacyCommand.execute as unknown as ExecuteWithDeps)(
      { interaction: interaction as never, commandName: "privacy" },
      { consentService: service },
    );
    const content = interaction.__replies[0]?.content ?? "";
    expect(content).toContain("`profile`");
  });
});

describe("/privacy delete", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "privacy-slash-"));
    cleanup = () => rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "data"), { recursive: true });
    process.chdir(dir);
  });

  afterEach(() => {
    cleanup();
  });

  it("first reply is the confirmation prompt with two buttons, all ephemeral", async () => {
    const interaction = makeInteraction({ options: { getSubcommand: () => "delete" } });
    await privacyCommand.execute({ interaction: interaction as never, commandName: "privacy" });
    expect(interaction.__replies).toHaveLength(1);
    const reply = interaction.__replies[0];
    expect(reply?.ephemeral).toBe(true);
    expect(reply?.content).toContain("本当に削除しますか");
    expect(reply?.components).toBeDefined();
    // ActionRowBuilder<ButtonBuilder>[] — make sure we got two buttons.
    const rows = reply?.components as Array<{
      components: Array<{ data: { custom_id?: string; label?: string } }>;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.components).toHaveLength(2);
    const buttons = rows?.[0]?.components ?? [];
    const labels = buttons.map((button) => button.data.label ?? "");
    expect(labels).toContain("削除を実行");
    expect(labels).toContain("キャンセル");
  });

  it("confirm button triggers clear() and updates the message", async () => {
    writeFileSync(
      join(dir, "data", "timekeeper-history.json"),
      JSON.stringify({ "user-1": ["2026-04-01"] }, null, 2),
      "utf8",
    );

    const requestId = "test-request-id";
    const interaction = makeInteraction({
      customId: `privacy:delete:confirm:${requestId}`,
    });

    await handlePrivacyButton(
      interaction as never,
      // generateRequestId does not matter for the clear call itself.
      { generateRequestId: () => requestId },
    );

    expect(interaction.__updates).toHaveLength(1);
    const update = interaction.__updates[0];
    expect(update?.ephemeral).toBe(true);
    expect(update?.components).toEqual([]);
    expect(update?.content).toContain("削除が完了しました");
  });

  it("cancel button posts a localized cancel message and clears buttons", async () => {
    const interaction = makeInteraction({ customId: "privacy:delete:cancel:abc" });
    await handlePrivacyButton(interaction as never);
    expect(interaction.__updates).toHaveLength(1);
    const update = interaction.__updates[0];
    expect(update?.content).toContain("キャンセル");
    expect(update?.components).toEqual([]);
    expect(update?.ephemeral).toBe(true);
  });

  it("unknown subcommand is reported as unknown", async () => {
    const interaction = makeInteraction({
      options: { getSubcommand: () => "what-is-this" },
    });
    await privacyCommand.execute({ interaction: interaction as never, commandName: "privacy" });
    expect(interaction.__replies[0]?.content).toContain("Unknown subcommand");
    expect(interaction.__replies[0]?.ephemeral).toBe(true);
  });

  it("handlePrivacyButton ignores unknown button custom ids", async () => {
    const interaction = makeInteraction({ customId: "totally:unrelated" });
    await handlePrivacyButton(interaction as never);
    expect(interaction.__replies).toHaveLength(0);
    expect(interaction.__updates).toHaveLength(0);
  });
});

// Re-exports the symbols for tests that want to drive the command via the
// type alias instead of the imported binding.
type _Privacy = typeof PrivacyCommandFn;
type _HandleButton = typeof HandlePrivacyButtonFn;
const _aliasOk: _Privacy = privacyCommand;
const _aliasOk2: _HandleButton = handlePrivacyButton;
void _aliasOk;
void _aliasOk2;

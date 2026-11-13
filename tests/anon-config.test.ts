import { describe, expect, it } from "vitest";

import { readAnonymousChatConfig } from "../src/features/anonymous-chat/config.js";

describe("readAnonymousChatConfig", () => {
  it("defaults to ephemeral mode with sane values", () => {
    const { config, warning } = readAnonymousChatConfig({});
    expect(config.audit).toBeNull();
    expect(warning).toBeUndefined();
    expect(config.cooldownMs).toBe(30_000);
    expect(config.maxMessageLength).toBe(1000);
    expect(config.denyChannelIds.size).toBe(0);
  });

  it("parses the deny-list and tunables", () => {
    const { config } = readAnonymousChatConfig({
      ANON_DENY_CHANNEL_IDS: " 111 , 222 ,, ",
      ANON_COOLDOWN_SECONDS: "5",
      ANON_MAX_MESSAGE_LENGTH: "500",
    });
    expect([...config.denyChannelIds].sort()).toEqual(["111", "222"]);
    expect(config.cooldownMs).toBe(5_000);
    expect(config.maxMessageLength).toBe(500);
  });

  it("enables audit when the public key is configured", () => {
    const { config, warning } = readAnonymousChatConfig({
      ANON_AUDIT_PUBLIC_KEY: "pub",
    });
    expect(config.audit).not.toBeNull();
    expect(config.audit?.publicKey).toBe("pub");
    expect(config.audit?.dir).toBe("data/anon-audit");
    expect(config.audit?.retentionDays).toBe(90);
    expect(warning).toBeUndefined();
  });

  it("warns that the removed index key is ignored", () => {
    const { config, warning } = readAnonymousChatConfig({
      ANON_AUDIT_PUBLIC_KEY: "pub",
      ANON_AUDIT_INDEX_KEY: "legacy-key",
    });
    expect(config.audit).not.toBeNull();
    expect(warning).toContain("ANON_AUDIT_INDEX_KEY");
  });

  it("ignores a stray index key when audit is not configured", () => {
    const { config } = readAnonymousChatConfig({
      ANON_AUDIT_INDEX_KEY: "legacy-key",
    });
    expect(config.audit).toBeNull();
  });
});

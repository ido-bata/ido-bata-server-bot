import { describe, expect, it } from "vitest";

import { readAnonymousChatConfig } from "../src/features/anonymous-chat/config.js";

describe("readAnonymousChatConfig", () => {
  it("defaults to audit-disabled with a loud warning — /anon refuses posts", () => {
    const { config, warning } = readAnonymousChatConfig({});
    expect(config.audit).toBeNull();
    // Audit is mandatory (Issue #118): an unset key is an ops gap,
    // not an ephemeral mode, so boot must warn.
    expect(warning).toContain("ANON_AUDIT_PUBLIC_KEY");
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
    expect(config.audit?.keyId).toBe("v1");
    expect(config.audit?.dir).toBe("data/anon-audit");
    expect(config.audit?.retentionDays).toBe(90);
    expect(warning).toBeUndefined();
  });

  it("parses a custom audit key id for rotation", () => {
    const { config } = readAnonymousChatConfig({
      ANON_AUDIT_PUBLIC_KEY: "pub",
      ANON_AUDIT_KEY_ID: "v2-next",
    });
    expect(config.audit?.keyId).toBe("v2-next");
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

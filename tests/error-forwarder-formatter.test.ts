import { describe, expect, it } from "vitest";

import {
  formatErrorEmbed,
  hashStack,
  shortHash,
  stackSignature,
  truncateDescription,
} from "../src/features/error-forwarder/formatter.js";

describe("error-forwarder formatter", () => {
  it("hashes the same stack consistently across Error instances", () => {
    const first = new Error("boom");
    const second = new Error("boom");
    // Force identical stacks by replacing them with a canonical string.
    first.stack = "Error: boom\n    at /app/foo.ts:1:1";
    second.stack = "Error: boom\n    at /app/foo.ts:1:1";

    expect(hashStack(first)).toBe(hashStack(second));
    expect(hashStack(first)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the hash when the stack changes", () => {
    const a = new Error("boom");
    a.stack = "Error: boom\n    at /app/foo.ts:1:1";
    const b = new Error("boom");
    b.stack = "Error: boom\n    at /app/bar.ts:9:9";

    expect(hashStack(a)).not.toBe(hashStack(b));
  });

  it("hashes string and plain-object errors without throwing", () => {
    expect(() => hashStack("plain string")).not.toThrow();
    expect(() => hashStack({ reason: "shape" })).not.toThrow();
    expect(() => hashStack({ reason: { nested: true } })).not.toThrow();

    const a = stackSignature("boom");
    const b = stackSignature("boom");
    expect(a).toBe(b);
  });

  it("truncates descriptions longer than the limit and flags the result", () => {
    const text = "x".repeat(5_000);
    const { text: trimmed, truncated } = truncateDescription(text, 256);

    expect(truncated).toBe(true);
    expect(trimmed.length).toBeLessThanOrEqual(256);
    expect(trimmed).toContain("truncated");
  });

  it("leaves short descriptions untouched", () => {
    const text = "small payload";
    const { text: trimmed, truncated } = truncateDescription(text, 256);

    expect(truncated).toBe(false);
    expect(trimmed).toBe(text);
  });

  it("formats a full Error into an embed with title, description, hash, and footer", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at /app/foo.ts:1:1";

    const result = formatErrorEmbed(
      error,
      {
        kind: "uncaughtException",
        timestamp: new Date("2026-09-13T12:00:00.000Z"),
        source: "ido-bata-server-bot@0.1.0",
        hostname: "ci-host",
        runtimeVersion: "node v22.0.0",
      },
      { maxDescriptionLength: 4096 },
    );

    expect(result.truncated).toBe(false);
    expect(result.requiresRestart).toBe(true);
    expect(result.stackHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.embed.title).toMatch(/uncaughtException/);
    expect(result.embed.description).toContain("Error: boom");
    expect(result.embed.footer.text).toContain("ci-host");
    expect(result.embed.footer.text).toContain("node v22.0.0");
    expect(result.embed.fields.map((f) => f.name)).toContain("Stack hash");
    expect(result.embed.fields.map((f) => f.name)).toContain("Restart required");

    expect(shortHash(result.stackHash)).toHaveLength(12);
  });

  it("formats an unhandledRejection without a restart flag", () => {
    const result = formatErrorEmbed(
      new Error("async boom"),
      {
        kind: "unhandledRejection",
        timestamp: new Date(),
        source: "ido-bata-server-bot@0.1.0",
      },
      { maxDescriptionLength: 4096 },
    );

    expect(result.requiresRestart).toBe(false);
    expect(result.embed.title).toMatch(/unhandledRejection/);
    expect(result.embed.fields.map((f) => f.name)).not.toContain("Restart required");
  });

  it("flags truncation when the stack overflows the Discord limit", () => {
    const error = new Error("boom");
    error.stack = "line\n".repeat(2_000);

    const result = formatErrorEmbed(
      error,
      {
        kind: "unhandledRejection",
        timestamp: new Date(),
        source: "ido-bata-server-bot@0.1.0",
      },
      { maxDescriptionLength: 512 },
    );

    expect(result.truncated).toBe(true);
    expect(result.requiresRestart).toBe(false);
  });

  it("accepts non-Error values and still produces a hash", () => {
    const result = formatErrorEmbed(
      "string rejection",
      {
        kind: "unhandledRejection",
        timestamp: new Date(),
        source: "ido-bata-server-bot@0.1.0",
      },
      { maxDescriptionLength: 4096 },
    );

    expect(result.stackHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.requiresRestart).toBe(false);
  });
});

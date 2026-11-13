import { describe, expect, it } from "vitest";

import { safeErrorFields } from "../src/features/anonymous-chat/errors.js";

describe("safeErrorFields", () => {
  it("extracts identifier-like name, enum code, and HTTP status", () => {
    const err = Object.assign(new Error("secret body user-1"), {
      name: "DiscordAPIError",
      code: 50013,
      status: 403,
    });
    expect(safeErrorFields(err)).toEqual({
      errName: "DiscordAPIError",
      errCode: 50013,
      errStatus: 403,
    });
  });

  it("accepts Node-style string codes like ENOENT", () => {
    const err = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    expect(safeErrorFields(err)).toEqual({ errName: "Error", errCode: "ENOENT" });
  });

  it("collapses non-whitelisted names to Error — arbitrary strings cannot flow", () => {
    for (const name of [
      "user-123456789012345678", // Discord snowflake-shaped
      "Error: user-1 posted secret-body",
      "CustomError", // identifier-shaped but NOT whitelisted
      "a".repeat(65), // too long
      "",
      42,
    ]) {
      const err = Object.assign(new Error("x"), { name });
      expect(safeErrorFields(err).errName).toBe("Error");
    }
    // Whitelisted names pass through.
    expect(safeErrorFields(Object.assign(new Error("x"), { name: "TypeError" })).errName).toBe(
      "TypeError",
    );
  });

  it("drops string codes not in the whitelist — snowflakes cannot pass", () => {
    const snowflake = "123456789012345678"; // 18-digit Discord id
    expect(snowflake).toHaveLength(18);
    const err = Object.assign(new Error("x"), { code: snowflake });
    expect(safeErrorFields(err)).not.toHaveProperty("errCode");
    // Identifier-shaped but unknown codes are also dropped.
    const custom = Object.assign(new Error("x"), { code: "SOME_CUSTOM_CODE" });
    expect(safeErrorFields(custom)).not.toHaveProperty("errCode");
    // Whitelisted errno/undici codes pass.
    for (const code of ["ENOENT", "ECONNRESET", "UND_ERR_SOCKET"]) {
      expect(safeErrorFields(Object.assign(new Error("x"), { code })).errCode).toBe(code);
    }
    // Discord numeric-string codes are not whitelisted — only numeric
    // codes in enum range are accepted.
    expect(safeErrorFields(Object.assign(new Error("x"), { code: "10003" }))).not.toHaveProperty(
      "errCode",
    );
  });

  it("drops numeric codes outside enum range", () => {
    const huge = Object.assign(new Error("x"), { code: 123456789 });
    expect(safeErrorFields(huge)).not.toHaveProperty("errCode");
    const negative = Object.assign(new Error("x"), { code: -1 });
    expect(safeErrorFields(negative).errCode).toBe(-1); // small ints still fine
  });

  it("drops out-of-range and non-integer statuses", () => {
    for (const status of [99, 600, 12345, 200.5, "403"]) {
      const err = Object.assign(new Error("x"), { status });
      expect(safeErrorFields(err)).not.toHaveProperty("errStatus");
    }
    const ok = Object.assign(new Error("x"), { httpStatus: 429 });
    expect(safeErrorFields(ok).errStatus).toBe(429);
  });

  it("never leaks message, stack, rawError, or thrown strings", () => {
    const err = Object.assign(new Error("body-secret user-1"), {
      stack: "stack-with-user-1",
      rawError: { content: "body-secret" },
      name: "DiscordAPIError",
      code: 0,
    });
    const fields = safeErrorFields(err);
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain("user-1");
    expect(serialized).not.toContain("body-secret");
    expect(serialized).not.toContain("rawError");
    expect(serialized).not.toContain("stack");
    // A thrown string carries no safe fields at all.
    expect(safeErrorFields("user-1 body-secret")).toEqual({ errName: "Error" });
    expect(safeErrorFields(null)).toEqual({ errName: "Error" });
    expect(safeErrorFields(undefined)).toEqual({ errName: "Error" });
  });
});

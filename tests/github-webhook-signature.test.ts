import { describe, expect, it } from "vitest";

import { computeSignature, verifySignature } from "../src/features/github-webhook/signature.js";

describe("GitHub webhook signature", () => {
  it("computes the HMAC SHA-256 signature with the sha256= prefix", () => {
    const secret = "super-secret";
    const payload = '{"hello":"world"}';

    const signature = computeSignature(secret, payload);

    expect(signature.startsWith("sha256=")).toBe(true);
    expect(signature).toBe(computeSignature(secret, payload));
    expect(signature).not.toBe(computeSignature("different", payload));
  });

  it("accepts a signature produced by the same secret", () => {
    const secret = "super-secret";
    const payload = '{"action":"published"}';

    expect(verifySignature(secret, payload, computeSignature(secret, payload))).toBe(true);
  });

  it("rejects a payload signed with a different secret", () => {
    const secret = "super-secret";
    const payload = '{"action":"published"}';

    expect(verifySignature(secret, payload, computeSignature("wrong", payload))).toBe(false);
  });

  it("rejects a payload that was tampered with after signing", () => {
    const secret = "super-secret";
    const original = '{"action":"published"}';
    const tampered = '{"action":"deleted"}';

    expect(verifySignature(secret, tampered, computeSignature(secret, original))).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifySignature("super-secret", "{}", null)).toBe(false);
  });

  it("rejects a signature header that does not use sha256=", () => {
    expect(verifySignature("super-secret", "{}", "md5=abcdef")).toBe(false);
  });
});
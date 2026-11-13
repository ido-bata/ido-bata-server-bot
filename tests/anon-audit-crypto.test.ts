import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  computeAnonIndex,
  createAnonCipher,
  publicKeyFromPrivate,
} from "../src/features/anonymous-chat/audit-crypto.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { format: "pem", type: "spki" },
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
});

describe("anon audit crypto", () => {
  it("seals a payload that only the private key can open", () => {
    const seal = createAnonCipher(publicKey);
    const ct = seal(JSON.stringify({ userId: "u1", guildId: "g1" }));
    expect(ct).not.toContain("u1");

    const opened = privateDecrypt(
      {
        key: privateKey,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(ct, "base64"),
    ).toString("utf8");
    expect(JSON.parse(opened)).toEqual({ userId: "u1", guildId: "g1" });
  });

  it("accepts base64 DER public key material", () => {
    const der = Buffer.from(
      publicKey.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s/g, ""),
      "base64",
    );
    const seal = createAnonCipher(der.toString("base64"));
    const ct = seal("payload");
    const opened = privateDecrypt(
      {
        key: privateKey,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(ct, "base64"),
    ).toString("utf8");
    expect(opened).toBe("payload");
  });

  it("throws on malformed key material (fail closed upstream)", () => {
    expect(() => createAnonCipher("not-a-key")).toThrow();
  });

  it("rejects private-key PEM material — the bot must never hold it", () => {
    expect(() => createAnonCipher(privateKey)).toThrow(/private-key/i);
    expect(() => createAnonCipher(privateKey.replace("PRIVATE KEY", "RSA PRIVATE KEY"))).toThrow(
      /private-key/i,
    );
  });

  it("derives public key material from a private key (test helper)", () => {
    expect(publicKeyFromPrivate(privateKey)).toContain("BEGIN PUBLIC KEY");
  });

  it("computes a stable, user-scoped HMAC index", () => {
    const a = computeAnonIndex("index-key-1234567890", "user-1");
    const b = computeAnonIndex("index-key-1234567890", "user-1");
    const c = computeAnonIndex("index-key-1234567890", "user-2");
    const d = computeAnonIndex("other-key-1234567890", "user-1");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("user-1");
  });
});

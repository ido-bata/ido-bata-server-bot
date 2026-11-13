/**
 * Public-key encryption for the `/anon` audit log (ADR-0003 §3).
 *
 * The bot only ever handles the RSA **public** key: `seal` produces
 * ciphertext that requires the offline-held private key to open.
 *
 * There is deliberately NO bot-computable per-user lookup index: any
 * deterministic tag over a Discord user id is dictionary-attackable
 * (guild rosters are public), so the bot host must not be able to
 * re-identify authors from stored records. `/privacy delete` therefore
 * cannot selectively remove audit records on the bot; deletion is an
 * offline custodian operation (`src/scripts/anon-audit-delete.ts`).
 */
import { constants, createPrivateKey, createPublicKey, publicEncrypt } from "node:crypto";

export type AnonAuditPlaintext = {
  userId: string;
  guildId: string;
  channelId: string;
  postedAt: string;
};

/**
 * Build a sealing function from PEM or base64/base64url SPKI material.
 * Throws on malformed input — callers decide whether audit is broken.
 */
export function createAnonCipher(publicKeyMaterial: string): (plaintext: string) => string {
  const trimmed = publicKeyMaterial.trim();
  // The private key must never enter the bot process (ADR-0003 §3).
  // `createPublicKey` would happily accept a private-key PEM and derive
  // the public half, so reject private-key material explicitly.
  if (/BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(trimmed)) {
    throw new Error("ANON_AUDIT_PUBLIC_KEY contains private-key material; refusing");
  }
  const keyObject = trimmed.includes("BEGIN")
    ? createPublicKey(trimmed)
    : createPublicKey({
        format: "der",
        key: Buffer.from(trimmed, "base64"),
        type: "spki",
      });

  return (plaintext: string): string =>
    publicEncrypt(
      {
        key: keyObject,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(plaintext, "utf8"),
    ).toString("base64");
}

/** Test/dev helper: derive the public key PEM from a private key PEM. */
export function publicKeyFromPrivate(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem))
    .export({ format: "pem", type: "spki" })
    .toString();
}

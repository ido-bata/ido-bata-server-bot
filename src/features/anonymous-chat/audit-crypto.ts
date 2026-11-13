/**
 * Public-key encryption + lookup index for the `/anon` audit log
 * (ADR-0003 §3).
 *
 * The bot only ever handles the RSA **public** key: `seal` produces
 * ciphertext that requires the offline-held private key to open. The
 * `ANON_AUDIT_INDEX_KEY` HMAC is a separate bot-held secret used solely
 * so `/privacy delete` can find a user's records without decrypting;
 * it reveals nothing about the mapping by itself.
 */
import {
  constants,
  createHmac,
  createPrivateKey,
  createPublicKey,
  publicEncrypt,
} from "node:crypto";

export type AnonAuditPlaintext = {
  userId: string;
  guildId: string;
  channelId: string;
  postedAt: string;
};

/**
 * Build a sealing function from PEM or base64/base64url SPKI material.
 * Throws on malformed input — callers decide whether to disable audit.
 */
export function createAnonCipher(publicKeyMaterial: string): (plaintext: string) => string {
  const trimmed = publicKeyMaterial.trim();
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

/** HMAC lookup index for `/privacy delete`. Not a decryption capability. */
export function computeAnonIndex(indexKey: string, userId: string): string {
  return createHmac("sha256", indexKey).update(userId, "utf8").digest("hex");
}

/** Test/dev helper: derive the public key PEM from a private key PEM. */
export function publicKeyFromPrivate(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem))
    .export({ format: "pem", type: "spki" })
    .toString();
}

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

export type EncryptedPayload = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
};

export function resolveEncryptionKey(hexKey: string | undefined): Buffer {
  if (!hexKey) {
    throw new Error(
      "STATE_SNAPSHOT_ENCRYPTION_KEY is required (hex-encoded 32-byte / 256-bit key).",
    );
  }

  const normalized = hexKey.trim();
  if (!/^[0-9a-fA-F]+$/.test(normalized)) {
    throw new Error("STATE_SNAPSHOT_ENCRYPTION_KEY must be hex-encoded.");
  }

  if (normalized.length !== KEY_BYTES * 2) {
    throw new Error(
      `STATE_SNAPSHOT_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (received ${normalized.length / 2}).`,
    );
  }

  return Buffer.from(normalized, "hex");
}

export function encryptBuffer(plaintext: Buffer, key: Buffer): EncryptedPayload {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes.`);
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return { authTag, ciphertext, iv };
}

export function decryptBuffer(payload: EncryptedPayload, key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes.`);
  }
  if (payload.iv.length !== IV_BYTES) {
    throw new Error(`IV must be ${IV_BYTES} bytes.`);
  }
  if (payload.authTag.length !== AUTH_TAG_BYTES) {
    throw new Error(`Auth tag must be ${AUTH_TAG_BYTES} bytes.`);
  }

  const decipher = createDecipheriv(ALGORITHM, key, payload.iv);
  decipher.setAuthTag(payload.authTag);
  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
}

export function verifyKey(expectedKey: Buffer, candidateKey: Buffer): boolean {
  if (expectedKey.length !== candidateKey.length) {
    return false;
  }
  return timingSafeEqual(expectedKey, candidateKey);
}
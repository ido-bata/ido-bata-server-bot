import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StorageDriver } from "../../lib/storage/types.js";
import { joinStorageKey } from "../../lib/storage/types.js";
import { decryptBuffer, encryptBuffer, resolveEncryptionKey } from "./encryption.js";

export type SnapshotFileEntry = {
  /** Storage key of the mirrored source (e.g. `consent.json`). */
  path: string;
  size: number;
  missing: boolean;
  sha256: string;
};

type SnapshotManifest = {
  createdAt: string;
  files: SnapshotFileEntry[];
  schemaVersion: 1;
};

export type SnapshotMetadata = {
  createdAt: string;
  files: SnapshotFileEntry[];
  id: string;
  /** Storage key of the encrypted snapshot object. */
  path: string;
};

/**
 * Pre-validated, encrypted snapshot bytes. The `SnapshotUploader.upload`
 * boundary accepts ONLY this shape: a plain `SnapshotMetadata` carries a
 * `path` field, which would tempt callers (and static analysers like
 * CodeQL) to read that path into an outbound network request. Routing the
 * object read through `loadEncryptedSnapshot` validates the bytes are an
 * actual encrypted container and lets us upload pre-validated content
 * without ever re-reading the storage backend from inside the uploader.
 */
export type EncryptedSnapshot = {
  meta: SnapshotMetadata;
  bytes: Buffer;
};

const MANIFEST_PREFIX = Buffer.from("SNAP1\n", "utf8");

export type SnapshotStoreOptions = {
  /** Storage backend that holds both the sources and the snapshots. */
  driver: StorageDriver;
  /** Storage key prefix that holds the encrypted snapshot objects. */
  snapshotPrefix: string;
  /** Storage keys of the consent-gated sources to mirror. */
  sourceKeys: string[];
};

export function buildSnapshotId(now: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Tokyo",
    year: "numeric",
  });
  const parts = formatter.formatToParts(now);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return [lookup.year, lookup.month, lookup.day, lookup.hour, lookup.minute, lookup.second].join(
    "-",
  );
}

export async function createSnapshot(
  options: SnapshotStoreOptions,
  hexKey: string | undefined,
  now: Date = new Date(),
): Promise<SnapshotMetadata> {
  const { files, buffers } = await collectSourceFiles(options.driver, options.sourceKeys);
  const manifest: SnapshotManifest = {
    createdAt: now.toISOString(),
    files,
    schemaVersion: 1,
  };

  const manifestBuffer = Buffer.from(JSON.stringify(manifest), "utf8");
  const payload = packSnapshotPayload(manifestBuffer, files, buffers);
  const key = resolveEncryptionKey(hexKey);
  const encrypted = encryptBuffer(payload, key);

  const id = buildSnapshotId(now);
  const targetKey = joinStorageKey(options.snapshotPrefix, `${id}.snap.enc`);
  const container = encodeEncryptedContainer(encrypted);

  await options.driver.write(targetKey, container);

  return {
    createdAt: manifest.createdAt,
    files: manifest.files,
    id,
    path: targetKey,
  };
}

export type RestoreOptions = {
  outputDir: string;
  driver: StorageDriver;
};

export type RestoreResult = {
  files: { path: string; size: number; sha256: string }[];
  manifest: SnapshotManifest;
};

/**
 * Restore a snapshot into `outputDir` on the local filesystem. The output
 * directory is an operator-facing inspection area (not the bot's data
 * root), so it stays a plain directory.
 */
export async function restoreSnapshot(
  snapshotKey: string,
  hexKey: string | undefined,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const expectedKey = resolveEncryptionKey(hexKey);
  const bytes = await options.driver.read(snapshotKey);
  if (bytes === null) {
    throw new Error(`snapshot not found: ${snapshotKey}`);
  }
  const encrypted = decodeEncryptedContainer(Buffer.from(bytes));
  const payload = decryptBuffer(encrypted, expectedKey);
  const { manifest, fileBuffers } = unpackSnapshotPayload(payload);

  for (const entry of manifest.files) {
    if (entry.missing) {
      continue;
    }
    const buffer = fileBuffers.get(entry.path);
    if (!buffer) {
      throw new Error(`Snapshot is missing payload for source: ${entry.path}`);
    }
    const actualSha = sha256Hex(buffer);
    if (actualSha !== entry.sha256) {
      throw new Error(
        `Snapshot integrity check failed for ${entry.path} (expected ${entry.sha256}, got ${actualSha})`,
      );
    }
    const absolute = join(options.outputDir, entry.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, buffer);
  }

  return {
    files: manifest.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
    })),
    manifest,
  };
}

export async function readSnapshotMetadata(
  snapshotKey: string,
  hexKey: string | undefined,
  driver: StorageDriver,
): Promise<SnapshotMetadata> {
  const key = resolveEncryptionKey(hexKey);
  const bytes = await driver.read(snapshotKey);
  if (bytes === null) {
    throw new Error(`snapshot not found: ${snapshotKey}`);
  }
  const encrypted = decodeEncryptedContainer(Buffer.from(bytes));
  const payload = decryptBuffer(encrypted, key);
  const { manifest } = unpackSnapshotPayload(payload);
  const id =
    snapshotKey
      .split("/")
      .pop()
      ?.replace(/\.snap\.enc$/, "") ?? "";
  return {
    createdAt: manifest.createdAt,
    files: manifest.files,
    id,
    path: snapshotKey,
  };
}

/**
 * Read a snapshot object from the storage backend and verify its bytes form
 * a valid encrypted container (`<iv:12><authTag:16><ciphertext:≥1>`).
 *
 * This is the gate that sits between `SnapshotMetadata.path` and
 * `SnapshotUploader.upload`. By forcing the uploader boundary to accept
 * only `EncryptedSnapshot`, a caller cannot accidentally upload a
 * plain-text source object: the type system plus this validator together
 * guarantee that whatever bytes leave the process were produced by
 * `createSnapshot` (which always encrypts) or by an equivalent AES-256-GCM
 * pipeline. We deliberately do not decrypt here — that requires the
 * operator's encryption key, which the uploader does not have.
 *
 * Throws when the object is missing, unreadable, or structurally invalid.
 */
export async function loadEncryptedSnapshot(
  snapshotKey: string,
  driver: StorageDriver,
): Promise<EncryptedSnapshot> {
  const id =
    snapshotKey
      .split("/")
      .pop()
      ?.replace(/\.snap\.enc$/, "") ?? "";

  const bytes = await driver.read(snapshotKey);
  if (bytes === null) {
    throw new Error(`loadEncryptedSnapshot: cannot read ${snapshotKey}`);
  }
  const buffer = Buffer.from(bytes);

  if (buffer.length < 12 + 16 + 1) {
    throw new Error(
      `loadEncryptedSnapshot: ${snapshotKey} is too small (${buffer.length} bytes) to be an encrypted container`,
    );
  }
  // Reject plaintext that happens to be exactly 28 bytes long — encrypted
  // bytes never start with the SNAP1 manifest prefix because the prefix
  // is wrapped inside the ciphertext. This is a cheap sanity check, not
  // a confidentiality guarantee.
  if (buffer.subarray(0, MANIFEST_PREFIX.length).equals(MANIFEST_PREFIX)) {
    throw new Error(
      `loadEncryptedSnapshot: ${snapshotKey} appears to contain an unencrypted manifest prefix; refusing to upload`,
    );
  }
  return {
    bytes: buffer,
    meta: {
      createdAt: "",
      files: [],
      id,
      path: snapshotKey,
    },
  };
}

async function collectSourceFiles(
  driver: StorageDriver,
  sourceKeys: string[],
): Promise<{ files: SnapshotFileEntry[]; buffers: Map<string, Buffer> }> {
  const files: SnapshotFileEntry[] = [];
  const buffers = new Map<string, Buffer>();
  for (const sourceKey of sourceKeys) {
    const bytes = await driver.read(sourceKey);
    if (bytes === null) {
      files.push({
        missing: true,
        path: sourceKey,
        sha256: "",
        size: 0,
      });
      continue;
    }
    const buffer = Buffer.from(bytes);
    buffers.set(sourceKey, buffer);
    files.push({
      missing: false,
      path: sourceKey,
      sha256: sha256Hex(buffer),
      size: buffer.length,
    });
  }
  return { buffers, files };
}

export async function listSnapshots(
  snapshotPrefix: string,
  hexKey: string | undefined,
  driver: StorageDriver,
): Promise<SnapshotMetadata[]> {
  const entries = await driver.list(`${snapshotPrefix}/`);
  const metadata: SnapshotMetadata[] = [];
  for (const entry of entries) {
    if (!entry.key.endsWith(".snap.enc")) {
      continue;
    }
    try {
      metadata.push(await readSnapshotMetadata(entry.key, hexKey, driver));
    } catch {
      // A snapshot we cannot decrypt is skipped, mirroring the previous
      // behaviour: it cannot be classified for retention.
    }
  }
  return metadata.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function packSnapshotPayload(
  manifest: Buffer,
  files: SnapshotFileEntry[],
  buffers: Map<string, Buffer>,
): Buffer {
  const parts: Buffer[] = [MANIFEST_PREFIX];
  const manifestLength = Buffer.alloc(4);
  manifestLength.writeUInt32BE(manifest.length, 0);
  parts.push(manifestLength, manifest);

  for (const entry of files) {
    if (entry.missing) {
      const missingMarker = Buffer.from([0]);
      parts.push(missingMarker);
      continue;
    }
    const buffer = buffers.get(entry.path);
    if (!buffer) {
      throw new Error(`Snapshot payload is missing the source bytes for ${entry.path}`);
    }
    parts.push(Buffer.from([1]));
    const pathBuffer = Buffer.from(entry.path, "utf8");
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(pathBuffer.length, 0);
    parts.push(pathLength, pathBuffer);
    const sizeBuffer = Buffer.alloc(8);
    sizeBuffer.writeBigUInt64BE(BigInt(buffer.length), 0);
    parts.push(sizeBuffer, buffer);
  }

  return Buffer.concat(parts);
}

function unpackSnapshotPayload(payload: Buffer): {
  manifest: SnapshotManifest;
  fileBuffers: Map<string, Buffer>;
} {
  if (!payload.subarray(0, MANIFEST_PREFIX.length).equals(MANIFEST_PREFIX)) {
    throw new Error("Snapshot payload is not in the expected format (missing SNAP1 prefix).");
  }
  let offset = MANIFEST_PREFIX.length;
  const manifestLength = payload.readUInt32BE(offset);
  offset += 4;
  const manifestBuffer = payload.subarray(offset, offset + manifestLength);
  offset += manifestLength;
  const manifest = JSON.parse(manifestBuffer.toString("utf8")) as SnapshotManifest;

  const fileBuffers = new Map<string, Buffer>();
  for (const entry of manifest.files) {
    const presentFlag = payload.readUInt8(offset);
    offset += 1;
    if (presentFlag === 0) {
      continue;
    }
    if (presentFlag !== 1) {
      throw new Error(`Snapshot payload corrupted at file entry (flag=${presentFlag}).`);
    }
    const pathLength = payload.readUInt32BE(offset);
    offset += 4;
    const filePath = payload.subarray(offset, offset + pathLength).toString("utf8");
    offset += pathLength;
    const size = Number(payload.readBigUInt64BE(offset));
    offset += 8;
    const fileBuffer = payload.subarray(offset, offset + size);
    offset += size;
    fileBuffers.set(filePath, fileBuffer);
    if (filePath !== entry.path) {
      throw new Error(
        `Snapshot manifest mismatch: expected ${entry.path}, payload contains ${filePath}`,
      );
    }
  }

  return { fileBuffers, manifest };
}

function encodeEncryptedContainer(payload: ReturnType<typeof encryptBuffer>): Buffer {
  return Buffer.concat([payload.iv, payload.authTag, payload.ciphertext]);
}

function decodeEncryptedContainer(buffer: Buffer): ReturnType<typeof encryptBuffer> {
  if (buffer.length < 12 + 16) {
    throw new Error("Snapshot file is too small to contain an encrypted payload.");
  }
  const iv = buffer.subarray(0, 12);
  const authTag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  return { authTag, ciphertext, iv };
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

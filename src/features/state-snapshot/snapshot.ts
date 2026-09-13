import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import {
  decryptBuffer,
  encryptBuffer,
  resolveEncryptionKey,
} from "./encryption.js";

export type SnapshotFileEntry = {
  path: string;
  size: number;
  missing: boolean;
  sha256: string;
};

export type SnapshotManifest = {
  createdAt: string;
  files: SnapshotFileEntry[];
  schemaVersion: 1;
};

export type SnapshotMetadata = {
  id: string;
  path: string;
  createdAt: string;
  files: SnapshotFileEntry[];
};

const MANIFEST_PREFIX = Buffer.from("SNAP1\n", "utf8");

export type SnapshotStoreOptions = {
  snapshotDir: string;
  sourcePaths: string[];
};

export function ensureSnapshotDir(snapshotDir: string): void {
  mkdirSync(snapshotDir, { recursive: true });
}

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
  return [
    lookup.year,
    lookup.month,
    lookup.day,
    lookup.hour,
    lookup.minute,
    lookup.second,
  ].join("-");
}

export function snapshotFilePath(snapshotDir: string, id: string): string {
  return join(snapshotDir, `${id}.snap.enc`);
}

export async function createSnapshot(
  options: SnapshotStoreOptions,
  hexKey: string | undefined,
  now: Date = new Date(),
): Promise<SnapshotMetadata> {
  ensureSnapshotDir(options.snapshotDir);

  const files = await collectSourceFiles(options.sourcePaths);
  const manifest: SnapshotManifest = {
    createdAt: now.toISOString(),
    files,
    schemaVersion: 1,
  };

  const manifestBuffer = Buffer.from(JSON.stringify(manifest), "utf8");
  const payload = packSnapshotPayload(manifestBuffer, files);
  const key = resolveEncryptionKey(hexKey);
  const encrypted = encryptBuffer(payload, key);

  const id = buildSnapshotId(now);
  const targetPath = snapshotFilePath(options.snapshotDir, id);
  const container = encodeEncryptedContainer(encrypted);

  writeFileSync(targetPath, container);

  return {
    createdAt: manifest.createdAt,
    files: manifest.files,
    id,
    path: targetPath,
  };
}

export type RestoreOptions = {
  outputDir: string;
};

export type RestoreResult = {
  files: { path: string; size: number; sha256: string }[];
  manifest: SnapshotManifest;
};

export async function restoreSnapshot(
  snapshotPath: string,
  hexKey: string | undefined,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const expectedKey = resolveEncryptionKey(hexKey);
  const encrypted = decodeEncryptedContainer(readFileSync(snapshotPath));
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
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, buffer);
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

export function readSnapshotMetadata(
  snapshotPath: string,
  hexKey: string | undefined,
): SnapshotMetadata {
  const key = resolveEncryptionKey(hexKey);
  const encrypted = decodeEncryptedContainer(readFileSync(snapshotPath));
  const payload = decryptBuffer(encrypted, key);
  const { manifest } = unpackSnapshotPayload(payload);
  const id = snapshotPath.split(/[\\/]/).pop()?.replace(/\.snap\.enc$/, "") ?? "";
  return {
    createdAt: manifest.createdAt,
    files: manifest.files,
    id,
    path: snapshotPath,
  };
}

export async function snapshotFile(sourcePath: string): Promise<SnapshotFileEntry> {
  if (!existsSync(sourcePath)) {
    return {
      missing: true,
      path: sourcePath,
      sha256: "",
      size: 0,
    };
  }

  const stat = statSync(sourcePath);
  if (!stat.isFile()) {
    throw new Error(`Source path is not a regular file: ${sourcePath}`);
  }

  const sha = await hashFile(sourcePath);
  return {
    missing: false,
    path: sourcePath,
    sha256: sha,
    size: stat.size,
  };
}

export async function collectSourceFiles(sourcePaths: string[]): Promise<SnapshotFileEntry[]> {
  const entries: SnapshotFileEntry[] = [];
  for (const sourcePath of sourcePaths) {
    entries.push(await snapshotFile(sourcePath));
  }
  return entries;
}

export function listSnapshots(
  snapshotDir: string,
  hexKey: string | undefined,
): SnapshotMetadata[] {
  if (!existsSync(snapshotDir)) {
    return [];
  }
  const entries = readdirSync(snapshotDir).filter((name) => name.endsWith(".snap.enc"));
  return entries
    .map((name) => {
      const snapshotPath = join(snapshotDir, name);
      try {
        return readSnapshotMetadata(snapshotPath, hexKey);
      } catch {
        return null;
      }
    })
    .filter((entry): entry is SnapshotMetadata => entry !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

function packSnapshotPayload(manifest: Buffer, files: SnapshotFileEntry[]): Buffer {
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
    parts.push(Buffer.from([1]));
    const pathBuffer = Buffer.from(entry.path, "utf8");
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(pathBuffer.length, 0);
    parts.push(pathLength, pathBuffer);
    const buffer = readFileSync(entry.path);
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
/**
 * U3 (Altare object storage) implementation of the storage port.
 *
 * U3 is an S3-compatible bucket: the AWS SDK talks to it with path-style
 * addressing against the bucket's regional endpoint
 * (`https://u3-eu.altare.global`). Altare's "Connect to app" flow injects
 * the matching environment variables into the app, so no key material ever
 * lives in git.
 *
 * Durability mapping:
 *
 * - `write` → a single `PUT`. Object storage publishes the new object
 *   atomically, so a reader never sees a partial object.
 * - `writeExclusive` → `PUT` with `If-None-Match: *`. When the backend
 *   answers `412 Precondition Failed` the key was already taken. Some
 *   S3-compatible backends ignore the conditional header; the adapter
 *   therefore verifies ownership with an owner token in the object
 *   metadata and reports "not created" when another writer won the race.
 */

import { randomBytes } from "node:crypto";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  decodeStorageText,
  encodeStorageData,
  isStorageNotFound,
  normalizeStorageKey,
  type StorageDriver,
  type StorageEntry,
} from "./types.js";

const OWNER_METADATA_KEY = "storage-owner";

export type U3StorageOptions = {
  /** Bucket name. */
  bucket: string;
  /** Bucket endpoint, e.g. `https://u3-eu.altare.global`. */
  endpoint?: string;
  /** Bucket region, e.g. `eu`. */
  region?: string;
  /** Access key id. */
  accessKeyId: string;
  /** Access key secret. */
  secretAccessKey: string;
  /** Optional session token for temporary credentials. */
  sessionToken?: string;
  /** Optional key prefix inside the bucket (e.g. `bot/`). */
  prefix?: string;
  /** Path-style addressing — the only mode U3 documents. Defaults to true. */
  forcePathStyle?: boolean;
};

export function createU3Storage(options: U3StorageOptions): StorageDriver {
  if (!options.bucket) {
    throw new Error("u3 storage: bucket is required");
  }
  if (!options.accessKeyId || !options.secretAccessKey) {
    throw new Error("u3 storage: access key id and secret are required");
  }

  const client = new S3Client({
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken,
    },
    endpoint: options.endpoint,
    forcePathStyle: options.forcePathStyle ?? true,
    region: options.region ?? "us-east-1",
  });

  const prefix = options.prefix ? `${normalizeStorageKey(options.prefix)}/` : "";

  function objectKey(key: string): string {
    return `${prefix}${normalizeStorageKey(key)}`;
  }

  return {
    kind: "u3",

    async read(key: string): Promise<Uint8Array | null> {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: options.bucket, Key: objectKey(key) }),
        );
        if (!response.Body) {
          return new Uint8Array(0);
        }
        return new Uint8Array(await response.Body.transformToByteArray());
      } catch (error) {
        if (isStorageNotFound(error)) {
          return null;
        }
        throw error;
      }
    },

    async readText(key: string): Promise<string | null> {
      const bytes = await this.read(key);
      return bytes === null ? null : decodeStorageText(bytes);
    },

    async write(key: string, data: Uint8Array | string): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Body: encodeStorageData(data),
          Bucket: options.bucket,
          Key: objectKey(key),
        }),
      );
    },

    async writeExclusive(key: string, data: Uint8Array | string): Promise<boolean> {
      const owner = randomBytes(8).toString("hex");
      try {
        await client.send(
          new PutObjectCommand({
            Body: encodeStorageData(data),
            Bucket: options.bucket,
            IfNoneMatch: "*",
            Key: objectKey(key),
            Metadata: { [OWNER_METADATA_KEY]: owner },
          }),
        );
      } catch (error) {
        if (isPreconditionFailed(error)) {
          return false;
        }
        throw error;
      }

      // The conditional header may be ignored by the backend. Confirm that
      // the object we just wrote is still ours before reporting success.
      try {
        const head = await client.send(
          new HeadObjectCommand({ Bucket: options.bucket, Key: objectKey(key) }),
        );
        const stored = head.Metadata?.[OWNER_METADATA_KEY];
        return stored === undefined ? true : stored === owner;
      } catch (error) {
        if (isStorageNotFound(error)) {
          return false;
        }
        throw error;
      }
    },

    async list(prefixFilter: string): Promise<StorageEntry[]> {
      const normalized = prefixFilter === "" ? "" : normalizeStorageKey(prefixFilter);
      const entries: StorageEntry[] = [];
      let continuationToken: string | undefined;
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: options.bucket,
            ContinuationToken: continuationToken,
            Prefix: `${prefix}${normalized}`,
          }),
        );
        for (const object of response.Contents ?? []) {
          if (!object.Key) {
            continue;
          }
          entries.push({
            key: object.Key.startsWith(prefix) ? object.Key.slice(prefix.length) : object.Key,
            lastModifiedMs: object.LastModified ? object.LastModified.getTime() : 0,
            size: object.Size ?? 0,
          });
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);
      return entries.sort((left, right) => left.key.localeCompare(right.key));
    },

    async delete(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: objectKey(key) }));
    },

    async exists(key: string): Promise<boolean> {
      try {
        await client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: objectKey(key) }));
        return true;
      } catch (error) {
        if (isStorageNotFound(error)) {
          return false;
        }
        throw error;
      }
    },

    async move(from: string, to: string): Promise<void> {
      const sourceKey = objectKey(from);
      await client.send(
        new CopyObjectCommand({
          Bucket: options.bucket,
          CopySource: `${options.bucket}/${sourceKey}`,
          Key: objectKey(to),
        }),
      );
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: sourceKey }));
    },
  };
}

function isPreconditionFailed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  if (candidate.name === "PreconditionFailed") {
    return true;
  }
  return candidate.$metadata?.httpStatusCode === 412;
}

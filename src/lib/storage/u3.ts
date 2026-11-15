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
  type PutObjectCommandOutput,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  type CompareAndSwapResult,
  decodeStorageText,
  encodeStorageData,
  isStorageNotFound,
  normalizeStorageKey,
  type StorageDriver,
  type StorageEntry,
  type VersionedObject,
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

    async readVersioned(key: string): Promise<VersionedObject | null> {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: options.bucket, Key: objectKey(key) }),
        );
        if (!response.Body) {
          return { data: new Uint8Array(0), version: response.ETag ?? null };
        }
        return {
          data: new Uint8Array(await response.Body.transformToByteArray()),
          version: response.ETag ?? null,
        };
      } catch (error) {
        if (isStorageNotFound(error)) {
          return null;
        }
        throw error;
      }
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

    /**
     * Conditional write.
     *
     * `expectedVersion: null` means "the key must not exist" → the request
     * carries `If-None-Match: *`. A non-null version means "the stored
     * ETag must still match" → the request carries `If-Match`.
     *
     * A backend that does not implement conditional writes answers with an
     * error we cannot distinguish from a transport failure. The result is
     * reported as `unsupported` so the caller can fail closed instead of
     * silently degrading the guarantee.
     */
    async compareAndSwap(
      key: string,
      data: Uint8Array | string,
      expectedVersion: string | null,
    ): Promise<CompareAndSwapResult> {
      // Pre-check: never issue a write we already know must fail. This
      // also protects against a backend that ignores the conditional
      // headers — the object is left untouched instead of clobbered.
      const current = await this.readVersioned(key);
      const currentVersion = current?.version ?? null;
      if (currentVersion !== expectedVersion) {
        return "conflict";
      }

      let response: PutObjectCommandOutput;
      try {
        response = await client.send(
          new PutObjectCommand({
            Body: encodeStorageData(data),
            Bucket: options.bucket,
            IfMatch: expectedVersion ?? undefined,
            IfNoneMatch: expectedVersion === null ? "*" : undefined,
            Key: objectKey(key),
          }),
        );
      } catch (error) {
        if (isPreconditionFailed(error)) {
          return "conflict";
        }
        if (isNotImplemented(error)) {
          return "unsupported";
        }
        throw error;
      }

      // Post-check: a backend that ignores the conditional headers answers
      // 2xx even when the object it replaced was not ours. Comparing the
      // stored ETag with the one we produced detects a write that raced.
      const stored = await this.readVersioned(key);
      if (!stored) {
        return "conflict";
      }
      if (response.ETag && stored.version && response.ETag !== stored.version) {
        return "conflict";
      }
      return "written";
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

    /**
     * Probe the backend itself: a create-if-absent write must succeed once
     * and fail the second time. A backend that ignores `If-None-Match`
     * answers 2xx both times and is reported as not supporting
     * conditional writes.
     */
    /**
     * Probe the backend itself. Both conditional paths the lease relies on
     * are checked:
     *
     * 1. **create-if-absent** (`If-None-Match: *`) must succeed once and
     *    fail the second time.
     * 2. **conditional update** (`If-Match: <etag>`) must succeed with
     *    the current ETag and fail with a stale one.
     *
     * A backend that honours only the first path would pass a
     * create-only probe while the renewal path (which updates an existing
     * term) silently overwrites the term of another instance.
     */
    async probeConditionalWrites(): Promise<boolean> {
      const key = `locks/probe-${randomBytes(6).toString("hex")}`;
      const body = encodeStorageData("probe");
      const cleanup = async (): Promise<void> => {
        await client
          .send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }))
          .catch(() => undefined);
      };

      // 1. create-if-absent
      let created: PutObjectCommandOutput;
      try {
        created = await client.send(
          new PutObjectCommand({
            Body: body,
            Bucket: options.bucket,
            IfNoneMatch: "*",
            Key: key,
          }),
        );
      } catch {
        await cleanup();
        return false;
      }
      try {
        await client.send(
          new PutObjectCommand({
            Body: body,
            Bucket: options.bucket,
            IfNoneMatch: "*",
            Key: key,
          }),
        );
        // The second create succeeded: the condition was ignored.
        await cleanup();
        return false;
      } catch (error) {
        if (!isPreconditionFailed(error)) {
          await cleanup();
          return false;
        }
      }

      // 2. conditional update — the path the lease renewal uses.
      const currentEtag = created.ETag;
      if (!currentEtag) {
        await cleanup();
        return false;
      }
      try {
        await client.send(
          new PutObjectCommand({
            Body: encodeStorageData("probe-2"),
            Bucket: options.bucket,
            IfMatch: currentEtag,
            Key: key,
          }),
        );
      } catch {
        // The update with the current ETag must succeed.
        await cleanup();
        return false;
      }
      try {
        await client.send(
          new PutObjectCommand({
            Body: encodeStorageData("probe-3"),
            Bucket: options.bucket,
            IfMatch: '"stale-etag"',
            Key: key,
          }),
        );
        // The stale update succeeded: `If-Match` is ignored, so a
        // renewal could overwrite a term taken over by another instance.
        await cleanup();
        return false;
      } catch (error) {
        await cleanup();
        return isPreconditionFailed(error);
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

/** Whether the backend rejected the conditional write as unimplemented. */
function isNotImplemented(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  if (candidate.name === "NotImplemented" || candidate.Code === "NotImplemented") {
    return true;
  }
  const status = candidate.$metadata?.httpStatusCode;
  return status === 501 || status === 400;
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

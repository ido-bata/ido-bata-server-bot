import { describe, expect, it } from "vitest";

import { readLeaseConfig, readStorageConfig } from "../src/lib/storage/index.js";

describe("storage configuration", () => {
  it("defaults to the local data directory", () => {
    const config = readStorageConfig({});
    expect(config).toEqual({ backend: "local", root: `${process.cwd()}/data` });
  });

  it("honours DATA_DIR for the local backend", () => {
    const config = readStorageConfig({ DATA_DIR: "/srv/bot-data" });
    expect(config).toEqual({ backend: "local", root: "/srv/bot-data" });
  });

  it("requires bucket and credentials for the u3 backend", () => {
    expect(() => readStorageConfig({ STORAGE_BACKEND: "u3" })).toThrow(/S3_BUCKET/);
    expect(() => readStorageConfig({ STORAGE_BACKEND: "u3", S3_BUCKET: "bucket" })).toThrow(
      /AWS_ACCESS_KEY_ID/,
    );
  });

  it("rejects an unknown backend", () => {
    expect(() => readStorageConfig({ STORAGE_BACKEND: "sqlite" })).toThrow(
      /unknown STORAGE_BACKEND/,
    );
  });

  it("defaults the lease backend to the data backend", () => {
    const config = readLeaseConfig({ STORAGE_BACKEND: "local", DATA_DIR: "/srv/bot-data" });
    expect(config).toEqual({ backend: "local", root: "/srv/bot-data" });
  });

  it("can put the lease in a shared bucket while the data stays local", () => {
    // The cutover case: the old host keeps writing to its local disk but
    // takes the lease in the bucket the new deployment uses.
    const config = readLeaseConfig({
      AWS_ACCESS_KEY_ID: "AKTEST",
      AWS_SECRET_ACCESS_KEY: "secret",
      DATA_DIR: "/srv/bot-data",
      LEASE_STORAGE_BACKEND: "u3",
      S3_BUCKET: "ido-bata-bot",
      STORAGE_BACKEND: "local",
    });
    expect(config.backend).toBe("u3");
    expect(config.backend === "u3" ? config.bucket : "").toBe("ido-bata-bot");
    // The data backend is untouched.
    expect(readStorageConfig({ DATA_DIR: "/srv/bot-data" }).backend).toBe("local");
  });

  it("uses the lease-specific bucket and credentials when they differ", () => {
    const config = readLeaseConfig({
      AWS_ACCESS_KEY_ID: "AKDATA",
      AWS_SECRET_ACCESS_KEY: "data-secret",
      LEASE_AWS_ACCESS_KEY_ID: "AKLEASE",
      LEASE_AWS_SECRET_ACCESS_KEY: "lease-secret",
      LEASE_S3_BUCKET: "lease-bucket",
      LEASE_STORAGE_BACKEND: "u3",
      S3_BUCKET: "data-bucket",
      STORAGE_BACKEND: "u3",
    });
    expect(config.backend === "u3" ? config.bucket : "").toBe("lease-bucket");
    expect(config.backend === "u3" ? config.accessKeyId : "").toBe("AKLEASE");
    expect(config.backend === "u3" ? config.secretAccessKey : "").toBe("lease-secret");
  });
});

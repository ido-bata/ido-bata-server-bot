import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Minimal S3-compatible object server used by the storage contract tests.
 *
 * It implements exactly the surface the U3 adapter uses:
 *
 * - `PUT /<bucket>/<key>` (honours `If-None-Match: *`)
 * - `GET` / `HEAD` / `DELETE /<bucket>/<key>`
 * - `GET /<bucket>?list-type=2&prefix=…`
 *
 * Authentication is ignored — the adapter's SigV4 signing is exercised by
 * the AWS SDK, not by this server.
 */
export type FakeS3Object = {
  body: Buffer;
  /** Content ETag, used by the conditional writes. */
  etag: string;
  metadata: Record<string, string>;
  lastModified: Date;
};

export type FakeS3Server = {
  endpoint: string;
  bucket: string;
  objects: Map<string, FakeS3Object>;
  close: () => Promise<void>;
};

export type FakeS3Options = {
  /**
   * When false the server ignores `If-None-Match` / `If-Match`, like a
   * backend that does not implement conditional writes. The lease probe
   * must detect that and refuse to start.
   */
  conformant?: boolean;
};

function etagOf(body: Buffer): string {
  return `"${createHash("sha256").update(body).digest("hex")}"`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

export async function startFakeS3Server(
  bucket = "test-bucket",
  options: FakeS3Options = {},
): Promise<FakeS3Server> {
  const objects = new Map<string, FakeS3Object>();
  const conformant = options.conformant ?? true;

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const [bucket, ...rest] = path.split("/");
    const key = rest.join("/");
    const objectKey = `${bucket}/${key}`;

    if (request.method === "GET" && key === "") {
      // ListObjectsV2
      const prefix = url.searchParams.get("prefix") ?? "";
      const matches = [...objects.entries()]
        .filter(([storedKey]) => storedKey.startsWith(`${bucket}/${prefix}`))
        .sort(([left], [right]) => left.localeCompare(right));
      const contents = matches
        .map(
          ([storedKey, object]) =>
            `<Contents><Key>${escapeXml(storedKey.slice(`${bucket}/`.length))}</Key><LastModified>${object.lastModified.toISOString()}</LastModified><ETag>${escapeXml(object.etag)}</ETag><Size>${object.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
        )
        .join("");
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/xml");
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${escapeXml(bucket)}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${matches.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
      );
      return;
    }

    if (request.method === "PUT") {
      const copySource = request.headers["x-amz-copy-source"];
      if (typeof copySource === "string") {
        // CopyObject: `x-amz-copy-source` carries `/<bucket>/<key>`.
        const sourceKey = decodeURIComponent(copySource)
          .replace(/^\//, "")
          .replace(new RegExp(`^${bucket}/`), "");
        const source = objects.get(`${bucket}/${sourceKey}`);
        if (!source) {
          response.statusCode = 404;
          response.end("<Error><Code>NoSuchKey</Code></Error>");
          return;
        }
        objects.set(objectKey, {
          body: source.body,
          etag: source.etag,
          lastModified: new Date(),
          metadata: { ...source.metadata },
        });
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/xml");
        response.end(
          `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>&quot;${source.etag}&quot;</ETag></CopyObjectResult>`,
        );
        return;
      }
      const body = await readBody(request);
      const ifNoneMatch = request.headers["if-none-match"];
      const ifMatch = request.headers["if-match"];
      if (conformant) {
        if (ifNoneMatch === "*" && objects.has(objectKey)) {
          response.statusCode = 412;
          response.end("<Error><Code>PreconditionFailed</Code></Error>");
          return;
        }
        if (typeof ifMatch === "string") {
          const current = objects.get(objectKey);
          if (!current || current.etag !== ifMatch) {
            response.statusCode = 412;
            response.end("<Error><Code>PreconditionFailed</Code></Error>");
            return;
          }
        }
      }
      const metadata: Record<string, string> = {};
      for (const [header, value] of Object.entries(request.headers)) {
        if (header.startsWith("x-amz-meta-") && typeof value === "string") {
          metadata[header.slice("x-amz-meta-".length)] = value;
        }
      }
      objects.set(objectKey, { body, etag: etagOf(body), lastModified: new Date(), metadata });
      response.statusCode = 200;
      response.setHeader("ETag", etagOf(body));
      response.end();
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      const object = objects.get(objectKey);
      if (!object) {
        response.statusCode = 404;
        response.end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      response.statusCode = 200;
      response.setHeader("ETag", object.etag);
      response.setHeader("Last-Modified", object.lastModified.toUTCString());
      for (const [name, value] of Object.entries(object.metadata)) {
        response.setHeader(`x-amz-meta-${name}`, value);
      }
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      response.end(object.body);
      return;
    }

    if (request.method === "DELETE") {
      objects.delete(objectKey);
      response.statusCode = 204;
      response.end();
      return;
    }

    response.statusCode = 400;
    response.end("<Error><Code>NotImplemented</Code></Error>");
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    bucket,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
  };
}

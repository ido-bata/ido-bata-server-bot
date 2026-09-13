import { EventEmitter } from "node:events";

import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import { HttpRouter } from "../src/http/router.js";
import { createHttpServer } from "../src/http/server.js";

function makeReq(method: string, url: string): IncomingMessage {
  const emitter = new EventEmitter();
  (emitter as unknown as IncomingMessage).method = method;
  (emitter as unknown as IncomingMessage).url = url;
  return emitter as unknown as IncomingMessage;
}

function captureResponse(): {
  res: ServerResponse;
  status: () => number;
  body: () => string;
} {
  let statusCode = 0;
  const chunks: Buffer[] = [];

  const res = {
    headersSent: true,
    writeHead(status: number) {
      statusCode = status;
    },
    end(payload?: string | Buffer) {
      if (payload !== undefined) {
        chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
      }
    },
    destroy() {
      // noop
    },
  } as unknown as ServerResponse;

  return {
    res,
    status: () => statusCode,
    body: () => Buffer.concat(chunks).toString("utf8"),
  };
}

describe("HttpRouter", () => {
  it("dispatches to the handler registered for the matching method+path", async () => {
    const router = new HttpRouter();
    router.add("POST", "/webhook/github", async (_req, res) => {
      res.writeHead(200, {});
      res.end("ok");
    });

    const captured = captureResponse();
    const matched = await router.dispatch(makeReq("POST", "/webhook/github"), captured.res);

    expect(matched).toBe(true);
    expect(captured.status()).toBe(200);
    expect(captured.body()).toBe("ok");
  });

  it("strips the query string before matching", async () => {
    const router = new HttpRouter();
    router.add("POST", "/webhook/github", async (_req, res) => {
      res.writeHead(202, {});
      res.end();
    });

    const captured = captureResponse();
    const matched = await router.dispatch(
      makeReq("POST", "/webhook/github?channel=foo"),
      captured.res,
    );

    expect(matched).toBe(true);
    expect(captured.status()).toBe(202);
  });

  it("returns 404 with a JSON body for unknown paths", async () => {
    const router = new HttpRouter();
    const captured = captureResponse();
    const matched = await router.dispatch(makeReq("GET", "/nope"), captured.res);

    expect(matched).toBe(false);
    expect(captured.status()).toBe(404);
    expect(JSON.parse(captured.body())).toEqual({ error: "not_found" });
  });

  it("treats method as case-insensitive", () => {
    const router = new HttpRouter();
    router.add("GET", "/health", async () => undefined);
    expect(router.has("get", "/health")).toBe(true);
  });

  it("binds multiple routes to one HTTP listener", async () => {
    const router = new HttpRouter();
    router.add("POST", "/webhook/github", async (_req, res) => {
      res.writeHead(200, {});
      res.end("webhook");
    });
    router.add("GET", "/health", async (_req, res) => {
      res.writeHead(200, {});
      res.end("health");
    });

    const handle = await createHttpServer({ host: "127.0.0.1", port: 0, router });
    try {
      const webhookRes = await fetch(`http://127.0.0.1:${handle.port}/webhook/github`, {
        method: "POST",
      });
      expect(webhookRes.status).toBe(200);
      expect(await webhookRes.text()).toBe("webhook");

      const healthRes = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(healthRes.status).toBe(200);
      expect(await healthRes.text()).toBe("health");

      const missing = await fetch(`http://127.0.0.1:${handle.port}/missing`);
      expect(missing.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});
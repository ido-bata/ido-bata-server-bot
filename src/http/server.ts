import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { childFor, getRootLogger } from "../lib/logger/index.js";
import type { HttpRouter } from "./router.js";

const logger = childFor(getRootLogger(), "http");

export type HttpServerHandle = {
  server: Server;
  /** The actual bound port (may differ from the requested port when port=0). */
  port: number;
  close: () => Promise<void>;
};

export type CreateHttpServerOptions = {
  host: string;
  port: number;
  router: HttpRouter;
};

/**
 * Shared HTTP/1.1 listener that multiplexes unrelated features
 * (`/health`, `/metrics`, `/webhook/github`, …) on a single TCP port.
 *
 * Each feature owns its routes — the composition root in `src/index.ts`
 * registers them with the shared router before calling `createHttpServer`.
 * Keeping a single listener is intentional: it matches the acceptance
 * criteria for issue #36 (which asks `/webhook/github` to live on the
 * same server as `/health` from issue #26) and avoids the operational
 * cost of one listener per feature.
 */
export function createHttpServer(options: CreateHttpServerOptions): Promise<HttpServerHandle> {
  const { host, port: requestedPort, router } = options;

  const server = createServer((req, res) => {
    invoke(router, req, res).catch((error: unknown) => {
      logger.error({ err: error }, "http server request failed");
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "internal_error" }));
      } else {
        res.destroy();
      }
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(requestedPort, host, () => {
      server.removeListener("error", onError);
      const address = server.address();
      const actualPort =
        typeof address === "object" && address ? (address as AddressInfo).port : requestedPort;
      resolve({
        server,
        port: actualPort,
        close: () => closeServer(server),
      });
    });
  });
}

async function invoke(
  router: HttpRouter,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await router.dispatch(req, res);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

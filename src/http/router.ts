import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Async handler for one HTTP route. The router matches by method + path
 * (path only, no query string) and delegates the rest of the request
 * lifecycle to the handler — body parsing, signature verification, JSON
 * serialization, etc. Handlers MUST write a response (or call `res.destroy()`)
 * before resolving.
 */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

/**
 * Tiny method+path router that the bot's HTTP server uses to multiplex
 * unrelated features (e.g. `/health`, `/metrics`, `/webhook/github`) on a
 * single listener. Each feature owns its routes; the composition root in
 * `src/index.ts` registers them with the shared router.
 *
 * The router is intentionally minimal: no path parameters, no middleware
 * chain. Adding either would re-introduce a tiny framework — pull in a
 * real one if the surface ever grows beyond a handful of routes.
 */
export class HttpRouter {
  private readonly routes = new Map<string, RouteHandler>();

  /**
   * Register `handler` for `method` + `path`. The latest registration
   * wins; duplicate keys overwrite, which keeps test setup concise.
   */
  add(method: string, path: string, handler: RouteHandler): void {
    this.routes.set(routeKey(method, path), handler);
  }

  /**
   * Dispatch `req` to the registered handler for its method+path. When no
   * route matches, responds with `404 not_found` and returns `false` so
   * callers can distinguish a real handler invocation from a miss.
   */
  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const method = (req.method ?? "GET").toUpperCase();
    const path = pathOf(req.url ?? "/");
    const handler = this.routes.get(routeKey(method, path));
    if (!handler) {
      sendJson(res, 404, { error: "not_found" });
      return false;
    }
    await handler(req, res);
    return true;
  }

  /** True if any handler is registered for `method` + `path`. */
  has(method: string, path: string): boolean {
    return this.routes.has(routeKey(method, path));
  }
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function pathOf(rawUrl: string): string {
  const queryStart = rawUrl.indexOf("?");
  const path = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  return path || "/";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
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
 * HTTP methods that the router will dispatch. Anything outside this set
 * is treated as "no match" so a malformed `req.method` cannot steer the
 * dispatcher toward a poisoned key. The narrow union is also the outer
 * key type of `HttpRouter#routes`, which keeps the handler selection
 * statically typed (no user-controlled string flowing into a single
 * dynamic key — the original CodeQL `js/unsafe-dynamic-method-call`
 * finding). Add to this set when the bot needs a new HTTP verb.
 */
export type AllowedMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

const ALLOWED_METHODS: readonly AllowedMethod[] = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

/** Narrow an arbitrary string to {@link AllowedMethod} when it matches the allowlist. */
function isAllowedMethod(method: string): method is AllowedMethod {
  return (ALLOWED_METHODS as readonly string[]).includes(method);
}

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
  /**
   * Outer key is the narrow `AllowedMethod` union (not a user-controlled
   * string), inner key is a registered path. Splitting the map like this
   * keeps handler selection typed end-to-end and avoids the
   * `js/unsafe-dynamic-method-call` shape flagged by CodeQL.
   */
  private readonly routes = new Map<AllowedMethod, Map<string, RouteHandler>>();

  /**
   * Register `handler` for `method` + `path`. The latest registration
   * wins; duplicate keys overwrite, which keeps test setup concise.
   * The `method` is normalized to upper-case and rejected outright if it
   * is not on the router's allowlist.
   */
  add(method: string, path: string, handler: RouteHandler): void {
    const normalized = method.toUpperCase();
    if (!isAllowedMethod(normalized)) {
      throw new RangeError(`unsupported HTTP method for router: ${method}`);
    }
    const methodRoutes = this.routes.get(normalized) ?? new Map<string, RouteHandler>();
    methodRoutes.set(path, handler);
    this.routes.set(normalized, methodRoutes);
  }

  /**
   * Dispatch `req` to the registered handler for its method+path. When no
   * route matches, responds with `404 not_found` and returns `false` so
   * callers can distinguish a real handler invocation from a miss.
   */
  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const rawMethod = (req.method ?? "GET").toUpperCase();
    if (!isAllowedMethod(rawMethod)) {
      sendJson(res, 405, { error: "method_not_allowed" }, { allow: ALLOW_HEADER });
      return false;
    }
    const methodRoutes = this.routes.get(rawMethod);
    const handler = methodRoutes?.get(pathOf(req.url ?? "/"));
    if (!handler) {
      sendJson(res, 404, { error: "not_found" });
      return false;
    }
    await handler(req, res);
    return true;
  }

  /** True if any handler is registered for `method` + `path`. */
  has(method: string, path: string): boolean {
    const normalized = method.toUpperCase();
    if (!isAllowedMethod(normalized)) {
      return false;
    }
    return this.routes.get(normalized)?.has(path) ?? false;
  }
}

const ALLOW_HEADER = ALLOWED_METHODS.join(", ");

function pathOf(rawUrl: string): string {
  const queryStart = rawUrl.indexOf("?");
  const path = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  return path || "/";
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

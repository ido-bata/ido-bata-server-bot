/**
 * Safe log fields for failures in the `/anon` pipeline (ADR-0003 §4).
 *
 * Discord API errors and arbitrary exceptions can embed request
 * payloads — message bodies, channel/user snowflake, interaction
 * data — inside `error.message`, `error.rawError`, or nested `errors`
 * objects. Pino does not redact those, and the error-forwarder would
 * ship them to the ops channel. We therefore log ONLY whitelisted
 * values — never arbitrary strings, no matter how identifier-shaped:
 *
 *   - `errName`   : the error's `name`, only when it is a KNOWN safe
 *                   class name (DiscordAPIError, TypeError, …).
 *                   Anything else collapses to "Error".
 *   - `errCode`   : Discord's numeric `code` when it is a safe
 *                   integer in enum range (|v| ≤ 999,999), or a
 *                   string `code` from a whitelist of common Node
 *                   errno / undici codes ("ENOENT", "ECONNRESET", …).
 *                   A Discord snowflake is 17+ digits and can never
 *                   match the whitelist.
 *   - `errStatus` : HTTP status, only integers in 100–599.
 *
 * `error.message`, `error.stack`, `error.rawError`, and any other
 * field are deliberately dropped.
 */

const SAFE_ERR_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AbortError",
  "TimeoutError",
  "DiscordAPIError",
  "DiscordjsError",
  "ZodError",
]);

// Common Node errno strings plus undici socket codes — the only string
// codes worth logging. Anything else (including any snowflake or
// user-controlled string) is dropped.
const SAFE_ERR_CODES: ReadonlySet<string> = new Set([
  "E2BIG",
  "EACCES",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EAGAIN",
  "EAI_AGAIN",
  "EALREADY",
  "EBADF",
  "EBUSY",
  "ECANCELED",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EDEADLK",
  "EDQUOT",
  "EEXIST",
  "EFAULT",
  "EFBIG",
  "EHOSTUNREACH",
  "EIDRM",
  "EILSEQ",
  "EINPROGRESS",
  "EINTR",
  "EINVAL",
  "EIO",
  "EISCONN",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "EMLINK",
  "EMSGSIZE",
  "ENAMETOOLONG",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENFILE",
  "ENOBUFS",
  "ENODATA",
  "ENODEV",
  "ENOENT",
  "ENOEXEC",
  "ENOLCK",
  "ENOLINK",
  "ENOMEM",
  "ENOMSG",
  "ENOPROTOOPT",
  "ENOSPC",
  "ENOSR",
  "ENOSTR",
  "ENOSYS",
  "ENOTCONN",
  "ENOTDIR",
  "ENOTEMPTY",
  "ENOTSOCK",
  "ENOTSUP",
  "ENOTTY",
  "ENXIO",
  "EOPNOTSUPP",
  "EOVERFLOW",
  "EPERM",
  "EPIPE",
  "EPROTO",
  "EPROTONOSUPPORT",
  "EPROTOTYPE",
  "ERANGE",
  "EROFS",
  "ESPIPE",
  "ESRCH",
  "ESTALE",
  "ETIME",
  "ETIMEDOUT",
  "ETXTBSY",
  "EWOULDBLOCK",
  "EXDEV",
  "UNKNOWN",
  "UND_ERR_ABORTED",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_INFO",
  "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
]);

const MAX_ERR_CODE_NUMBER = 999_999;

export function safeErrorFields(error: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = { errName: "Error" };
  if (error === null || typeof error !== "object") {
    return fields;
  }
  const e = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    httpStatus?: unknown;
  };
  if (typeof e.name === "string" && SAFE_ERR_NAMES.has(e.name)) {
    fields.errName = e.name;
  }
  if (
    typeof e.code === "number" &&
    Number.isSafeInteger(e.code) &&
    Math.abs(e.code) <= MAX_ERR_CODE_NUMBER
  ) {
    fields.errCode = e.code;
  } else if (typeof e.code === "string" && SAFE_ERR_CODES.has(e.code)) {
    fields.errCode = e.code;
  }
  const status =
    typeof e.status === "number"
      ? e.status
      : typeof e.httpStatus === "number"
        ? e.httpStatus
        : undefined;
  if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
    fields.errStatus = status;
  }
  return fields;
}

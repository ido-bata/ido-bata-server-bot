/**
 * Safe log fields for failures in the `/anon` pipeline (ADR-0003 §4).
 *
 * Discord API errors and arbitrary exceptions can embed request
 * payloads — message bodies, channel/user snowflakes, interaction
 * data — inside `error.message`, `error.rawError`, or nested `errors`
 * objects. Pino does not redact those, and the error-forwarder would
 * ship them to the ops channel. We therefore log ONLY structurally
 * safe fields, each shape-checked so arbitrary strings cannot flow
 * through:
 *
 *   - `errName`   : the error's `name`, only when it looks like an
 *                   identifier (letters/digits/_/$, ≤64 chars) —
 *                   e.g. "DiscordAPIError", "TypeError". Anything
 *                   else collapses to "Error".
 *   - `errCode`   : Discord's numeric `code` when it is a safe
 *                   integer in enum range, or a short code string
 *                   (≤16 identifier chars, e.g. "ENOENT", "10003").
 *                   A Discord snowflake is 17+ digits, so it can
 *                   never pass the string shape; oversized numbers
 *                   are dropped.
 *   - `errStatus` : HTTP status, only integers in 100–599.
 *
 * `error.message`, `error.stack`, `error.rawError`, and any other
 * field are deliberately dropped.
 */

const SAFE_ERR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const SAFE_ERR_CODE = /^[A-Za-z0-9_]{1,16}$/;
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
  if (typeof e.name === "string" && SAFE_ERR_NAME.test(e.name)) {
    fields.errName = e.name;
  }
  if (
    typeof e.code === "number" &&
    Number.isSafeInteger(e.code) &&
    Math.abs(e.code) <= MAX_ERR_CODE_NUMBER
  ) {
    fields.errCode = e.code;
  } else if (typeof e.code === "string" && SAFE_ERR_CODE.test(e.code)) {
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

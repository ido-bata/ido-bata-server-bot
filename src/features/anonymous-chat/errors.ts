/**
 * Safe log fields for failures in the `/anon` pipeline (ADR-0003 §4).
 *
 * Discord API errors and arbitrary exceptions can embed request
 * payloads — message bodies, channel/user snowflakes, interaction
 * data — inside `error.message`, `error.rawError`, or nested `errors`
 * objects. Pino does not redact those, and the error-forwarder would
 * ship them to the ops channel. We therefore log ONLY:
 *
 *   - `errName`   : the error's `name` (e.g. "DiscordAPIError",
 *                   "TypeError") — a fixed identifier, never content.
 *   - `errCode`   : Discord's numeric/string error `code` when present
 *                   (e.g. 50013 Missing Permissions) — an enum value,
 *                   never user data.
 *   - `errStatus` : HTTP status when present.
 *
 * `error.message`, `error.stack`, `error.rawError`, and any other
 * field are deliberately dropped.
 */
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
  if (typeof e.name === "string" && e.name.length > 0 && e.name.length <= 64) {
    fields.errName = e.name;
  }
  if (typeof e.code === "number" || (typeof e.code === "string" && e.code.length <= 32)) {
    fields.errCode = e.code;
  }
  const status =
    typeof e.status === "number"
      ? e.status
      : typeof e.httpStatus === "number"
        ? e.httpStatus
        : undefined;
  if (status !== undefined && Number.isInteger(status)) {
    fields.errStatus = status;
  }
  return fields;
}

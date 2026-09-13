import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compute the value of GitHub's `X-Hub-Signature-256` header for a given
 * payload. The result is prefixed with `sha256=` to match what GitHub
 * sends on the wire.
 */
export function computeSignature(secret: string, payload: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(payload, "utf8");
  return `sha256=${hmac.digest("hex")}`;
}

/**
 * Constant-time comparison of an incoming `X-Hub-Signature-256` header
 * against the expected HMAC. Returns `false` when the header is missing,
 * malformed, or produced by a different secret.
 *
 * We intentionally use `timingSafeEqual` to avoid leaking information
 * about the secret via response time.
 */
export function verifySignature(
  secret: string,
  payload: string,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader) {
    return false;
  }

  if (!signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = computeSignature(secret, payload);
  const provided = signatureHeader;

  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");

  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, providedBuf);
}
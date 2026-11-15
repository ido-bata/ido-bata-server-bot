/**
 * Runtime configuration for the anonymous-chat (`/anon`) feature.
 *
 * All values come from env vars read once at boot in `src/index.ts`.
 *
 * Audit is MANDATORY (Issue #118, ADR-0003 §3): there is no unlogged
 * posting mode.
 *   - `ANON_AUDIT_PUBLIC_KEY` unset → `audit: null` — the service
 *     reports `auditState: "disabled"` and refuses every post.
 *   - `ANON_AUDIT_PUBLIC_KEY` set → audit configured. If the key
 *     material is invalid the service reports `auditState: "error"`
 *     and refuses to post — a configured audit must never silently
 *     degrade.
 */

export type AnonAuditConfig = {
  /** PEM (`-----BEGIN PUBLIC KEY-----`) or base64/base64url SPKI DER. */
  publicKey: string;
  /** Key id written into each record envelope; bump on rotation. */
  keyId: string;
  /** Storage key prefix holding the per-record audit files. */
  dir: string;
  /** Record files older than this many days are swept. */
  retentionDays: number;
};

export type AnonymousChatConfig = {
  /** Channel ids where /anon is always denied (supplementary deny-list). */
  denyChannelIds: ReadonlySet<string>;
  /** Per-user cooldown between attempts, in milliseconds. */
  cooldownMs: number;
  /** Maximum trimmed message length accepted by `/anon`. */
  maxMessageLength: number;
  /** Audit persistence config, or null when no public key is set. */
  audit: AnonAuditConfig | null;
};

const DEFAULT_COOLDOWN_SECONDS = 30;
const DEFAULT_MAX_MESSAGE_LENGTH = 1000;
const DEFAULT_AUDIT_DIR = "anon-audit";
const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const DEFAULT_AUDIT_KEY_ID = "v1";

/**
 * Resolve the audit storage prefix from raw env input.
 *
 * The records live in the storage backend (ADR-0004): the local
 * `data/anon-audit` directory on a single host, the `anon-audit/`
 * prefix inside the U3 bucket on Altare. A legacy `data/anon-audit`
 * value is normalised to the storage prefix so an existing operator
 * setting keeps pointing at the same records.
 */
export function resolveAnonAuditDir(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return DEFAULT_AUDIT_DIR;
  }
  const normalized = trimmed
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^data\//, "")
    .replace(/\/+$/, "");
  return normalized || DEFAULT_AUDIT_DIR;
}

export type AnonConfigEnv = {
  ANON_DENY_CHANNEL_IDS?: string;
  ANON_COOLDOWN_SECONDS?: string;
  ANON_MAX_MESSAGE_LENGTH?: string;
  ANON_AUDIT_PUBLIC_KEY?: string;
  ANON_AUDIT_KEY_ID?: string;
  /** Deprecated: the HMAC lookup index was removed (ADR-0003 §3). */
  ANON_AUDIT_INDEX_KEY?: string;
  ANON_AUDIT_DIR?: string;
  ANON_AUDIT_RETENTION_DAYS?: string;
};

function parseIdList(raw: string | undefined): ReadonlySet<string> {
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolveAudit(env: AnonConfigEnv): { audit: AnonAuditConfig | null; warning?: string } {
  const publicKey = env.ANON_AUDIT_PUBLIC_KEY?.trim() ?? "";

  if (!publicKey) {
    // Audit is mandatory (Issue #118): an unset key does not mean
    // "ephemeral mode", it means /anon refuses every post. Warn at
    // boot so a missing key is an visible ops gap, not a silent
    // feature outage.
    return {
      audit: null,
      warning:
        "anonymous-chat: ANON_AUDIT_PUBLIC_KEY is not set; /anon will refuse all posts (audit is required)",
    };
  }

  return {
    audit: {
      publicKey,
      keyId: env.ANON_AUDIT_KEY_ID?.trim() || DEFAULT_AUDIT_KEY_ID,
      dir: resolveAnonAuditDir(env.ANON_AUDIT_DIR),
      retentionDays: parsePositiveInt(env.ANON_AUDIT_RETENTION_DAYS, DEFAULT_AUDIT_RETENTION_DAYS),
    },
    // The removed HMAC index key is meaningless now — warn so operators
    // do not believe it still protects anything.
    warning: env.ANON_AUDIT_INDEX_KEY
      ? "anonymous-chat: ANON_AUDIT_INDEX_KEY is no longer used and can be removed"
      : undefined,
  };
}

export function readAnonymousChatConfig(env: AnonConfigEnv): {
  config: AnonymousChatConfig;
  warning?: string;
} {
  const { audit, warning } = resolveAudit(env);
  return {
    config: {
      denyChannelIds: parseIdList(env.ANON_DENY_CHANNEL_IDS),
      cooldownMs: parsePositiveInt(env.ANON_COOLDOWN_SECONDS, DEFAULT_COOLDOWN_SECONDS) * 1000,
      maxMessageLength: parsePositiveInt(env.ANON_MAX_MESSAGE_LENGTH, DEFAULT_MAX_MESSAGE_LENGTH),
      audit,
    },
    warning,
  };
}

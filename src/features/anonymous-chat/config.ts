/**
 * Runtime configuration for the anonymous-chat (`/anon`) feature.
 *
 * All values come from env vars read once at boot in `src/index.ts`.
 * The audit block is `null` unless BOTH `ANON_AUDIT_PUBLIC_KEY` and
 * `ANON_AUDIT_INDEX_KEY` are supplied — a public key without the index
 * key would persist records that `/privacy delete` cannot target, so
 * the pair is all-or-nothing (ADR-0003 §3).
 */

export type AnonAuditConfig = {
  /** PEM (`-----BEGIN PUBLIC KEY-----`) or base64/base64url SPKI DER. */
  publicKey: string;
  /** Random bot-held HMAC key for the per-user lookup index. */
  indexKey: string;
  /** Directory holding daily `YYYY-MM-DD.jsonl` audit files. */
  dir: string;
  /** Daily audit files older than this many days are swept. */
  retentionDays: number;
};

export type AnonymousChatConfig = {
  /** Channel ids where /anon is always denied (supplementary deny-list). */
  denyChannelIds: ReadonlySet<string>;
  /** Per-user cooldown between attempts, in milliseconds. */
  cooldownMs: number;
  /** Maximum trimmed message length accepted by `/anon`. */
  maxMessageLength: number;
  /** Audit persistence config, or null for ephemeral-only mode. */
  audit: AnonAuditConfig | null;
};

const DEFAULT_COOLDOWN_SECONDS = 30;
const DEFAULT_MAX_MESSAGE_LENGTH = 1000;
const DEFAULT_AUDIT_DIR = "data/anon-audit";
const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const MIN_INDEX_KEY_LENGTH = 16;

export type AnonConfigEnv = {
  ANON_DENY_CHANNEL_IDS?: string;
  ANON_COOLDOWN_SECONDS?: string;
  ANON_MAX_MESSAGE_LENGTH?: string;
  ANON_AUDIT_PUBLIC_KEY?: string;
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
  const indexKey = env.ANON_AUDIT_INDEX_KEY?.trim() ?? "";

  if (!publicKey && !indexKey) {
    return { audit: null };
  }
  if (!publicKey || !indexKey) {
    // All-or-nothing: storing records without a working delete index
    // would violate the privacy contract, so we degrade to ephemeral
    // mode and surface the misconfiguration loudly instead of throwing
    // (which would take the whole bot down for an optional feature).
    return {
      audit: null,
      warning:
        "anonymous-chat: ANON_AUDIT_PUBLIC_KEY and ANON_AUDIT_INDEX_KEY must both be set; audit persistence disabled",
    };
  }
  if (indexKey.length < MIN_INDEX_KEY_LENGTH) {
    return {
      audit: null,
      warning: `anonymous-chat: ANON_AUDIT_INDEX_KEY must be at least ${MIN_INDEX_KEY_LENGTH} characters; audit persistence disabled`,
    };
  }

  return {
    audit: {
      publicKey,
      indexKey,
      dir: env.ANON_AUDIT_DIR?.trim() || DEFAULT_AUDIT_DIR,
      retentionDays: parsePositiveInt(env.ANON_AUDIT_RETENTION_DAYS, DEFAULT_AUDIT_RETENTION_DAYS),
    },
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

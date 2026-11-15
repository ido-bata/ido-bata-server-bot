/**
 * Offline `/anon` audit lookup core — custodian-only (ADR-0003 §3,
 * Issue #118).
 *
 * Audit records are RSA-OAEP ciphertext with no bot-computable
 * per-user index, so the bot host cannot map a Discord `messageId`
 * (or user id) to an author. The audit-key custodian runs this
 * OFFLINE with the private key (`src/scripts/anon-audit-lookup.ts`).
 *
 * Every record is decrypted and inspected before results are returned —
 * same fail-closed posture as the deletion tool: a corrupt record,
 * missing `ct`, undecryptable record, or unreadable object aborts the
 * run rather than risk reporting an incomplete correlation.
 *
 * Rotation: `privateKeys` may hold several PEM keys; each record is
 * tried against them in order so records sealed under an older `kid`
 * still resolve during the overlap window.
 */
import { constants, createPrivateKey, privateDecrypt } from "node:crypto";

import { getStorageDriver } from "../../lib/storage/index.js";
import type { StorageDriver } from "../../lib/storage/types.js";
import { joinStorageKey } from "../../lib/storage/types.js";

const FILE_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T.*)?\.jsonl$/;

/** Decrypted audit payload (v2 attempt/posted, or legacy v1 mapping). */
export type AnonAuditPlaintextRecord = {
  userId: string;
  guildId: string;
  channelId: string;
  postedAt: string;
  kind?: string;
  attemptId?: string;
  messageId?: string;
  v?: number;
};

export type AnonAuditLookupFilter = {
  messageId?: string;
  userId?: string;
  attemptId?: string;
  /** List attempt records that have no matching posted record. */
  unmatchedAttempts?: boolean;
};

export type AnonAuditLookupMatch = {
  /** Record key — operational handle, not sensitive. */
  file: string;
  plaintext: AnonAuditPlaintextRecord;
};

export type AnonAuditLookupResult =
  | {
      ok: true;
      scanned: number;
      matched: AnonAuditLookupMatch[];
      /** Attempt plaintexts lacking a posted record (anomaly report). */
      unmatchedAttempts: AnonAuditPlaintextRecord[];
    }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function decryptRecord(
  ct: string,
  keys: ReturnType<typeof createPrivateKey>[],
): AnonAuditPlaintextRecord {
  let lastError: unknown;
  for (const key of keys) {
    try {
      const opened = privateDecrypt(
        {
          key,
          oaepHash: "sha256",
          padding: constants.RSA_PKCS1_OAEP_PADDING,
        },
        Buffer.from(ct, "base64"),
      ).toString("utf8");
      const plaintext: unknown = JSON.parse(opened);
      if (
        !isRecord(plaintext) ||
        typeof plaintext.userId !== "string" ||
        typeof plaintext.guildId !== "string" ||
        typeof plaintext.channelId !== "string" ||
        typeof plaintext.postedAt !== "string"
      ) {
        throw new Error("malformed decrypted record");
      }
      // Discriminated v2 schema: any v2 marker (v/kind/attemptId/
      // messageId) requires the full shape for its kind. Records with
      // NONE of those fields are legacy v1 mappings ({userId, guildId,
      // channelId, postedAt}) and stay valid for deletion-era files.
      const hasV2Marker =
        "v" in plaintext ||
        "kind" in plaintext ||
        "attemptId" in plaintext ||
        "messageId" in plaintext;
      if (hasV2Marker) {
        if (plaintext.v !== 2) {
          throw new Error("unsupported audit record version");
        }
        if (plaintext.kind !== "attempt" && plaintext.kind !== "posted") {
          throw new Error("unknown audit record kind");
        }
        if (typeof plaintext.attemptId !== "string" || plaintext.attemptId.length === 0) {
          throw new Error("audit record missing attemptId");
        }
        if (
          plaintext.kind === "posted" &&
          (typeof plaintext.messageId !== "string" || plaintext.messageId.length === 0)
        ) {
          throw new Error("posted audit record missing messageId");
        }
      }
      return plaintext as AnonAuditPlaintextRecord;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function matchesFilter(record: AnonAuditPlaintextRecord, filter: AnonAuditLookupFilter): boolean {
  if (filter.messageId !== undefined && record.messageId !== filter.messageId) {
    return false;
  }
  if (filter.userId !== undefined && record.userId !== filter.userId) {
    return false;
  }
  if (filter.attemptId !== undefined && record.attemptId !== filter.attemptId) {
    return false;
  }
  return true;
}

export async function lookupAnonAuditRecords(options: {
  dir: string;
  /** PEM private keys (PKCS8) — custodian material, never on the bot. */
  privateKeys: string[];
  filter: AnonAuditLookupFilter;
  /** Storage backend to read from. Defaults to the configured backend. */
  driver?: StorageDriver;
}): Promise<AnonAuditLookupResult> {
  const { dir, filter } = options;
  if (options.privateKeys.length === 0) {
    return { ok: false, error: "at least one private key is required" };
  }
  const keys = options.privateKeys.map((pem) => createPrivateKey(pem));
  const driver = options.driver ?? getStorageDriver();

  const entries = await driver.list(dir === "" ? "" : `${dir}/`);
  const names = entries
    .map((entry) => (dir === "" ? entry.key : entry.key.slice(`${dir}/`.length)))
    .filter((name) => FILE_NAME_PATTERN.test(name));

  const matched: AnonAuditLookupMatch[] = [];
  const attempts: AnonAuditPlaintextRecord[] = [];
  const postedAttemptIds = new Set<string>();
  // `matched` is populated only for identifier queries. A pure
  // --unmatched anomaly scan must not dump the whole decrypted
  // history — the caller asked for orphan attempts only.
  const hasIdFilter =
    filter.messageId !== undefined || filter.userId !== undefined || filter.attemptId !== undefined;
  let scanned = 0;

  try {
    for (const name of names) {
      const raw = await driver.readText(joinStorageKey(dir, name));
      if (raw === null) {
        continue; // swept between listing and reading
      }
      const lines = raw.split("\n").filter((line) => line.trim() !== "");
      if (lines.length === 0) {
        return { ok: false, error: `empty record file ${name}; nothing returned` };
      }
      for (const line of lines) {
        scanned += 1;
        let envelope: unknown;
        try {
          envelope = JSON.parse(line);
        } catch {
          return { ok: false, error: `corrupt record file ${name}; nothing returned` };
        }
        if (!isRecord(envelope) || typeof envelope.ct !== "string" || envelope.ct.length === 0) {
          return { ok: false, error: `record file ${name} has no ciphertext; nothing returned` };
        }
        let plaintext: AnonAuditPlaintextRecord;
        try {
          plaintext = decryptRecord(envelope.ct, keys);
        } catch {
          return {
            ok: false,
            error: `undecryptable or malformed record in ${name}; nothing returned`,
          };
        }
        if (plaintext.kind === "attempt" || (plaintext.kind === undefined && plaintext.attemptId)) {
          attempts.push(plaintext);
        }
        if (plaintext.kind === "posted" && typeof plaintext.attemptId === "string") {
          postedAttemptIds.add(plaintext.attemptId);
        }
        if (hasIdFilter && matchesFilter(plaintext, filter)) {
          matched.push({ file: name, plaintext });
        }
      }
      // Yield periodically so large histories do not starve other work.
      await new Promise((resolve) => setImmediate(resolve));
    }
  } catch (error) {
    return {
      ok: false,
      error: `anon-audit-lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const unmatchedAttempts =
    filter.unmatchedAttempts === true
      ? attempts.filter(
          (a) =>
            matchesFilter(a, filter) &&
            (typeof a.attemptId !== "string" || !postedAttemptIds.has(a.attemptId)),
        )
      : [];

  return { ok: true, scanned, matched, unmatchedAttempts };
}

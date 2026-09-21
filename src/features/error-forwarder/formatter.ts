import { createHash } from "node:crypto";

const TRUNCATION_MARKER_TAIL = 64;
const HASH_PREFIX_LENGTH = 12;

export type ErrorKind = "uncaughtException" | "unhandledRejection";

export type ErrorContext = {
  kind: ErrorKind;
  /** When the event fired. */
  timestamp: Date;
  /** Process label, e.g. "ido-bata-server-bot@0.1.0". */
  source: string;
  /** Optional name of the host the process was running on. */
  hostname?: string;
  /** Optional Node.js / discord.js version for context. */
  runtimeVersion?: string;
};

type ErrorEmbedField = {
  name: string;
  value: string;
  inline?: boolean;
};

export type ErrorEmbedData = {
  title: string;
  description: string;
  color: number;
  timestamp: Date;
  footer: { text: string };
  fields: ErrorEmbedField[];
};

export type FormattedErrorEmbed = {
  embed: ErrorEmbedData;
  /** SHA-256 hex digest of the canonical stack signature. */
  stackHash: string;
  /** True when the description had to be truncated to fit Discord. */
  truncated: boolean;
  /** True when an `uncaughtException` was captured (process may need a restart). */
  requiresRestart: boolean;
  /** True when at least one secret-shaped token was redacted from the embed. */
  redacted: boolean;
};

/**
 * Patterns that look like credentials. We match on shape rather than
 * config keys so accidental string interpolation of a raw secret in an
 * error message or stack trace is scrubbed before the embed leaves the
 * process. Mirrors the pino redaction paths in `src/lib/logger/index.ts`.
 */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  // Discord bot tokens (classic and newer prefix forms).
  { name: "discordToken", regex: /[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}/g },
  // Generic bearer / Authorization header values.
  {
    name: "authorization",
    regex: /(?:bearer|token)\s+[A-Za-z0-9._\-+/=]{12,}/gi,
  },
  // `password=...` / `pwd=...` style URL or form params.
  {
    name: "passwordParam",
    regex: /\b(password|pwd|passwd|secret|api[_-]?key)\s*[:=]\s*["']?[^\s"',;&]{4,}/gi,
  },
  // STATE_SNAPSHOT_ENCRYPTION_KEY (32-byte hex / base64).
  {
    name: "encryptionKey",
    regex: /\b[A-Fa-f0-9]{64}\b/g,
  },
];

function redactSecrets(input: string): { text: string; redacted: boolean } {
  let redacted = false;
  let text = input;
  for (const { name, regex } of SECRET_PATTERNS) {
    text = text.replace(regex, () => {
      redacted = true;
      return `[REDACTED:${name}]`;
    });
  }
  return { text, redacted };
}

/**
 * Build a stable signature for an unknown error value so identical stacks share
 * a hash even if the surrounding Error instance is reconstructed by Node.
 */
export function stackSignature(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}\n${error.message}\n${error.stack ?? ""}`;
  }

  if (typeof error === "string") {
    return `String\n${error}`;
  }

  try {
    return `Other\n${JSON.stringify(error)}`;
  } catch {
    return `Other\n${String(error)}`;
  }
}

export function hashStack(error: unknown): string {
  return createHash("sha256").update(stackSignature(error)).digest("hex");
}

export function truncateDescription(
  text: string,
  maxLength: number,
): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxLength) {
    return { text, truncated: false };
  }

  // Reserve room for the marker so moderators still see a hint about hashing.
  const budget = Math.max(maxLength - TRUNCATION_MARKER_TAIL, 0);
  const marker = `\n... (truncated, see hash below)`;
  const usableBudget = Math.max(budget - marker.length, 0);

  return {
    text: `${text.slice(0, usableBudget)}${marker}`,
    truncated: true,
  };
}

export function shortHash(hash: string): string {
  return hash.slice(0, HASH_PREFIX_LENGTH);
}

function normalizeError(error: unknown): { name: string; message: string; stack: string } {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || "",
      stack: error.stack ?? "",
    };
  }

  if (typeof error === "string") {
    return { name: "NonError", message: error, stack: "" };
  }

  try {
    return { name: "NonError", message: JSON.stringify(error, null, 2), stack: "" };
  } catch {
    return { name: "NonError", message: String(error), stack: "" };
  }
}

/**
 * Format an error into embed-ready plain data. Pure / side-effect-free so it
 * can be exercised in tests without any live Discord client. The service
 * layer wraps the returned data into a real `EmbedBuilder` for sending.
 */
export function formatErrorEmbed(
  error: unknown,
  context: ErrorContext,
  options: { maxDescriptionLength: number },
): FormattedErrorEmbed {
  const normalized = normalizeError(error);
  // The stack hash is computed against the *raw* (pre-redaction) signature
  // so identical errors keep the same hash across runs regardless of which
  // patterns happen to fire. Redaction only affects what leaves the
  // process — it never changes the diagnostic identity of the error.
  const stackHash = hashStack(error);

  const title =
    context.kind === "uncaughtException"
      ? "uncaughtException — process restart may be required"
      : "unhandledRejection — investigate async chain";
  const footerParts = [context.source];
  if (context.hostname) {
    footerParts.push(context.hostname);
  }
  if (context.runtimeVersion) {
    footerParts.push(context.runtimeVersion);
  }

  const bodySections: string[] = [];
  bodySections.push(`**Type**: \`${normalized.name}\``);
  const redactedMessage = redactSecrets(normalized.message || "<empty>");
  bodySections.push(`**Message**: ${redactedMessage.text}`);
  const redactedFooter = redactSecrets(footerParts.join(" | "));
  const redactedStack = normalized.stack
    ? redactSecrets(normalized.stack)
    : { text: "", redacted: false };

  if (normalized.stack) {
    bodySections.push("**Stack**:");
    bodySections.push(`\`\`\`\n${redactedStack.text}\n\`\`\``);
  } else {
    bodySections.push("**Stack**: <none>");
  }

  const rawBody = bodySections.join("\n");
  const { text: description, truncated } = truncateDescription(
    rawBody,
    options.maxDescriptionLength,
  );

  const fields: ErrorEmbedField[] = [
    { name: "Stack hash", value: `\`${shortHash(stackHash)}\``, inline: true },
  ];
  if (context.kind === "uncaughtException") {
    fields.push({ name: "Restart required", value: "yes", inline: true });
  }
  const redacted = redactedMessage.redacted || redactedFooter.redacted || redactedStack.redacted;

  return {
    embed: {
      title,
      description,
      color: 0xff4d4f,
      timestamp: context.timestamp,
      footer: { text: redactedFooter.text },
      fields,
    },
    stackHash,
    truncated,
    requiresRestart: context.kind === "uncaughtException",
    redacted,
  };
}

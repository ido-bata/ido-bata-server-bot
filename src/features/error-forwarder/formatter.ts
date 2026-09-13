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

export type ErrorEmbedField = {
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
};

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
  bodySections.push(`**Message**: ${normalized.message || "<empty>"}`);

  if (normalized.stack) {
    bodySections.push("**Stack**:");
    bodySections.push(`\`\`\`\n${normalized.stack}\n\`\`\``);
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

  return {
    embed: {
      title,
      description,
      color: 0xff4d4f,
      timestamp: context.timestamp,
      footer: { text: footerParts.join(" | ") },
      fields,
    },
    stackHash,
    truncated,
    requiresRestart: context.kind === "uncaughtException",
  };
}

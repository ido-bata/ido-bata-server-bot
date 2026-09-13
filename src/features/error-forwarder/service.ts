import type { Client } from "discord.js";
import { EmbedBuilder, type TextChannel } from "discord.js";

import { errorForwarderConfig, isErrorForwarderConfigured } from "./config.js";
import {
  type ErrorContext,
  type ErrorEmbedData,
  type ErrorKind,
  formatErrorEmbed,
  hashStack,
  shortHash,
} from "./formatter.js";
import { StackRateLimiter } from "./rate-limit.js";

export type LoggerLike = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

export type ErrorReporterOptions = {
  config?: typeof errorForwarderConfig;
  logger?: LoggerLike;
  limiter?: StackRateLimiter;
  /** Resolves a TextChannel by id. Replaced with a fake in tests. */
  resolveChannel?: (channelId: string) => Promise<TextChannel | null> | TextChannel | null;
  /** Builds an EmbedBuilder from formatted data. Replaced with a spy in tests. */
  buildEmbed?: (data: ErrorEmbedData) => unknown;
  /** Sends a formatted embed; replaced with a spy in tests. */
  sendEmbed?: (channel: TextChannel, embed: unknown) => Promise<unknown>;
  /** Builds the ErrorContext; injected so tests can fix timestamps. */
  buildContext?: (kind: ErrorKind) => ErrorContext;
  now?: () => Date;
};

const DEFAULT_LOGGER: LoggerLike = {
  info: (message, meta) => console.log(`[error-forwarder] ${message}`, meta ?? {}),
  warn: (message, meta) => console.warn(`[error-forwarder] ${message}`, meta ?? {}),
  error: (message, meta) => console.error(`[error-forwarder] ${message}`, meta ?? {}),
};

const DEFAULT_CONTEXT_BUILDER =
  (now: () => Date, source: string) =>
  (kind: ErrorKind): ErrorContext => ({
    kind,
    timestamp: now(),
    source,
    hostname: undefined,
    runtimeVersion: `node ${process.version}`,
  });

export type ErrorReporter = {
  report: (error: unknown, kind: ErrorKind) => Promise<void>;
  /** Drop the per-stack buckets; useful from tests and graceful shutdown. */
  resetLimiter: () => void;
};

export function createErrorReporter(
  client: Client | null,
  options: ErrorReporterOptions = {},
): ErrorReporter {
  const config = options.config ?? errorForwarderConfig;
  const logger = options.logger ?? DEFAULT_LOGGER;
  const now = options.now ?? (() => new Date());
  const source = `${process.title || "node"}@${process.env.npm_package_version ?? "0.0.0"}`;
  const buildContext = options.buildContext ?? DEFAULT_CONTEXT_BUILDER(now, source);

  const limiter =
    options.limiter ??
    new StackRateLimiter({
      maxPerWindow: config.maxPerWindow,
      windowMs: config.windowMs,
      now,
    });

  const resolveChannel =
    options.resolveChannel ??
    (async (channelId: string) => {
      if (!client) {
        return null;
      }
      const channel = client.channels.cache.get(channelId);
      if (!channel?.isTextBased() || channel.isDMBased()) {
        return null;
      }
      return channel as TextChannel;
    });

  const buildEmbed = options.buildEmbed ?? ((data: ErrorEmbedData) => new EmbedBuilder(data));

  const sendEmbed =
    options.sendEmbed ??
    (async (channel: TextChannel, embed: unknown) => {
      await channel.send({ embeds: [embed as never] });
    });

  async function forward(error: unknown, kind: ErrorKind): Promise<void> {
    const context = buildContext(kind);
    const formatted = formatErrorEmbed(error, context, {
      maxDescriptionLength: config.maxDescriptionLength,
    });

    const decision = limiter.hit(formatted.stackHash);
    if (!decision.allowed) {
      logger.warn("error-forwarder rate-limited", {
        stackHash: shortHash(formatted.stackHash),
        kind,
        seenInWindow: decision.seenInWindow,
        resetsAt: decision.resetsAt.toISOString(),
      });
      return;
    }

    const logMeta = {
      stackHash: shortHash(formatted.stackHash),
      kind,
      truncated: formatted.truncated,
      requiresRestart: formatted.requiresRestart,
    };

    if (formatted.requiresRestart) {
      logger.error(
        config.uncaughtExceptionIsFatal
          ? "uncaughtException captured — restart required"
          : "uncaughtException captured — process will continue",
        logMeta,
      );
    } else {
      logger.error("unhandledRejection captured", logMeta);
    }

    if (!isErrorForwarderConfigured(config)) {
      logger.warn("error-forwarder channel not configured; logger-only fallback", logMeta);
      return;
    }

    try {
      const channel = await resolveChannel(config.channelId);
      if (!channel) {
        logger.warn("error-forwarder channel not resolvable; logger-only fallback", {
          ...logMeta,
          channelId: config.channelId,
        });
        return;
      }

      const embed = buildEmbed(formatted.embed);
      await sendEmbed(channel, embed);
    } catch (sendError) {
      logger.error("failed to deliver error-forwarder embed", {
        ...logMeta,
        channelId: config.channelId,
        sendError: sendError instanceof Error ? sendError.message : String(sendError),
      });
    }
  }

  return {
    report: (error, kind) => forward(error, kind),
    resetLimiter: () => limiter.reset(),
  };
}

export function registerErrorForwarder(
  client: Client,
  options: Omit<ErrorReporterOptions, "client" | "resolveChannel"> = {},
): ErrorReporter {
  const reporter = createErrorReporter(client, options);

  process.on("uncaughtException", (error) => {
    void reporter.report(error, "uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    void reporter.report(reason, "unhandledRejection");
  });

  return reporter;
}

/**
 * Hash helper re-exported so consumers can correlate logs with embeds without
 * importing the formatter module directly.
 */
export { hashStack as hashErrorStack, shortHash };

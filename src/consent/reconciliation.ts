import type { Client } from "discord.js";

import type { ConsentConfig } from "./config.js";
import type { ConsentLogger } from "./logger.js";
import type { ConsentService } from "./service.js";
import type { ReactionTarget, ReconcileReport } from "./types.js";

/**
 * Resolve the `ReactionTarget[]` the reconciler should walk. Right now
 * there is exactly one consent message per guild with one emoji per
 * scope; the structure is future-proofed so #94 (consumer wiring) can
 * extend it without changing the public API.
 */
export function resolveReactionTargets(config: ConsentConfig): ReactionTarget[] {
  if (!config.enabled) {
    return [];
  }
  const targets: ReactionTarget[] = [];
  for (const emoji of Object.keys(config.emojiToScope)) {
    targets.push({
      guildId: config.guildId,
      channelId: config.channelId,
      messageId: config.messageId,
      emoji,
    });
  }
  return targets;
}

export type ReconcileOnReadyDeps = {
  client: Client;
  service: ConsentService;
  config: ConsentConfig;
  logger?: ConsentLogger;
};

const noopLogger: ConsentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child() {
    return noopLogger;
  },
};

/**
 * `ClientReady` handler. Runs `service.reconcile(targets)` and logs a
 * summary. Failures from the report are surfaced on the logger so an
 * operator can investigate Discord API outages — the reconciler never
 * auto-grants on failure (that is `ConsentService.reconcile`'s job).
 *
 * Bot-user filtering happens in two places:
 *   1. The fetcher drops `user.bot === true` rows.
 *   2. The service drops rows where `userId === botUserId`.
 * Both are belt-and-suspenders so a misconfigured fetcher still cannot
 * self-grant the bot user.
 */
export async function reconcileConsentsOnReady(
  deps: ReconcileOnReadyDeps,
): Promise<ReconcileReport> {
  const log = deps.logger ?? noopLogger;
  const targets = resolveReactionTargets(deps.config);
  if (targets.length === 0) {
    log.info("reconcile: no targets configured, skipping");
    return { appliedGrants: [], appliedRevokes: [], failures: [] };
  }
  const report = await deps.service.reconcile(targets);
  log.info(
    `reconcile: applied ${report.appliedGrants.length} grant(s), ${report.appliedRevokes.length} revoke(s), ${report.failures.length} failure(s)`,
  );
  if (report.failures.length > 0) {
    const unique = [...new Set(report.failures)];
    log.warn(`reconcile: failures for guild(s) ${unique.join(", ")}`);
  }
  return report;
}

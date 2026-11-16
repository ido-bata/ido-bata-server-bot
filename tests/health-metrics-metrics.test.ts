import { describe, expect, it } from "vitest";

import { escapeLabelValue, MetricsRegistry } from "../src/features/health-metrics/metrics.js";

describe("MetricsRegistry", () => {
  it("uses the injected uptime provider when supplied", () => {
    const registry = new MetricsRegistry({ getUptimeSec: () => 7 });
    expect(registry.snapshot().uptimeSec).toBe(7);
  });

  it("falls back to Math.floor(process.uptime()) when no provider is supplied", () => {
    const registry = new MetricsRegistry();
    // uptime should be a non-negative integer.
    expect(Number.isInteger(registry.snapshot().uptimeSec)).toBe(true);
    expect(registry.snapshot().uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it("aggregates command invocations by (command, status)", () => {
    const registry = new MetricsRegistry();

    registry.recordCommandInvocation("ping", "ok");
    registry.recordCommandInvocation("ping", "ok");
    registry.recordCommandInvocation("ping", "error");
    registry.recordCommandInvocation("help", "ok");

    const text = registry.toPrometheusText();
    expect(text).toMatch(/^bot_command_invocations_total\{command="help",status="ok"\} 1$/m);
    expect(text).toMatch(/^bot_command_invocations_total\{command="ping",status="ok"\} 2$/m);
    expect(text).toMatch(/^bot_command_invocations_total\{command="ping",status="error"\} 1$/m);
  });

  it("reflects discord_ws_connected flips in the snapshot and Prometheus text", () => {
    const registry = new MetricsRegistry();
    expect(registry.snapshot().discordWsConnected).toBe(false);
    expect(registry.toPrometheusText()).toContain("bot_discord_ws_connected 0");

    registry.setDiscordWsConnected(true);
    expect(registry.snapshot().discordWsConnected).toBe(true);
    expect(registry.toPrometheusText()).toContain("bot_discord_ws_connected 1");
  });

  it("reflects timekeeper active session count", () => {
    const registry = new MetricsRegistry();
    registry.setTimekeeperActiveSessions(0);
    expect(registry.toPrometheusText()).toContain("bot_timekeeper_active_sessions 0");

    registry.setTimekeeperActiveSessions(1);
    expect(registry.toPrometheusText()).toContain("bot_timekeeper_active_sessions 1");
  });

  it("rejects negative or non-finite timekeeperActiveSessions", () => {
    const registry = new MetricsRegistry();
    expect(() => registry.setTimekeeperActiveSessions(-1)).toThrow();
    expect(() => registry.setTimekeeperActiveSessions(Number.NaN)).toThrow();
    expect(() => registry.setTimekeeperActiveSessions(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("renders Prometheus text with HELP and TYPE for each metric", () => {
    const registry = new MetricsRegistry({ getUptimeSec: () => 42 });
    registry.setDiscordWsConnected(true);
    registry.setTimekeeperActiveSessions(1);
    registry.recordCommandInvocation("hello", "ok");

    const text = registry.toPrometheusText();
    expect(text).toMatch(/^# HELP bot_uptime_seconds /m);
    expect(text).toMatch(/^# TYPE bot_uptime_seconds gauge$/m);
    expect(text).toMatch(/^# HELP bot_discord_ws_connected /m);
    expect(text).toMatch(/^# TYPE bot_discord_ws_connected gauge$/m);
    expect(text).toMatch(/^# HELP bot_timekeeper_active_sessions /m);
    expect(text).toMatch(/^# TYPE bot_timekeeper_active_sessions gauge$/m);
    expect(text).toMatch(/^# HELP bot_command_invocations_total /m);
    expect(text).toMatch(/^# TYPE bot_command_invocations_total counter$/m);

    expect(text).toMatch(/^bot_uptime_seconds 42$/m);
    expect(text).toMatch(/^bot_discord_ws_connected 1$/m);
    expect(text).toMatch(/^bot_timekeeper_active_sessions 1$/m);
    expect(text).toMatch(/^bot_command_invocations_total\{command="hello",status="ok"\} 1$/m);
  });

  it("escapes special characters in Prometheus label values", () => {
    const registry = new MetricsRegistry();
    registry.recordCommandInvocation('weird"name', "ok");
    registry.recordCommandInvocation("back\\slash", "error");
    registry.recordCommandInvocation("with\nnewline", "ok");

    const text = registry.toPrometheusText();
    expect(text).toContain('command="weird\\"name"');
    expect(text).toContain('command="back\\\\slash"');
    expect(text).toContain('command="with\\nnewline"');
  });

  it("emits no command series before any invocation is recorded", () => {
    const registry = new MetricsRegistry({ getUptimeSec: () => 0 });
    const text = registry.toPrometheusText();
    // Counter section is only emitted when there is at least one series.
    // HELP/TYPE for the counter family should still be present? No — by
    // Prometheus convention, families with no series are omitted.
    expect(text).not.toContain("bot_command_invocations_total{");
  });

  it("ends the rendered Prometheus text with a newline", () => {
    const registry = new MetricsRegistry();
    expect(registry.toPrometheusText().endsWith("\n")).toBe(true);
  });

  it("omits the next-session series until a session is scheduled", () => {
    const registry = new MetricsRegistry({ getUptimeSec: () => 0 });
    expect(registry.toPrometheusText()).not.toMatch(/^bot_timekeeper_next_session_at /m);
  });

  it("exposes the scheduled session start as a Unix timestamp", () => {
    const registry = new MetricsRegistry({ getUptimeSec: () => 0 });
    // 2026-11-17T12:00:00Z — the next 21:00 JST slot.
    const at = new Date("2026-11-17T12:00:00Z");
    registry.setTimekeeperNextSessionAt(at);

    const text = registry.toPrometheusText();
    expect(text).toMatch(/^# TYPE bot_timekeeper_next_session_at gauge$/m);
    expect(text).toMatch(
      new RegExp(`^bot_timekeeper_next_session_at ${Math.floor(at.getTime() / 1000)}$`, "m"),
    );
    expect(registry.getTimekeeperNextSessionAt()).toBe(Math.floor(at.getTime() / 1000));
  });

  it("drops the series again when the schedule is cleared", () => {
    const registry = new MetricsRegistry({ getUptimeSec: () => 0 });
    registry.setTimekeeperNextSessionAt(new Date("2026-11-17T12:00:00Z"));
    registry.setTimekeeperNextSessionAt(null);

    expect(registry.toPrometheusText()).not.toMatch(/^bot_timekeeper_next_session_at /m);
    expect(registry.getTimekeeperNextSessionAt()).toBeNull();
  });
});

describe("escapeLabelValue", () => {
  it("escapes backslash, double-quote, and newline", () => {
    expect(escapeLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
  });

  it("leaves ordinary characters untouched", () => {
    expect(escapeLabelValue("hello-world_42")).toBe("hello-world_42");
  });
});

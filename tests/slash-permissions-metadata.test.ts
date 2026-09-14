import { describe, expect, it } from "vitest";

import {
  buildSlashPermissionMetadata,
  renderSlashPermissionMarkdown,
} from "../src/features/slash-permissions/metadata.js";
import { defaultMemberPermissionsFor } from "../src/features/slash-permissions/policy.js";

describe("slash permission metadata", () => {
  it("returns a sorted, JSON-friendly snapshot of every rule", () => {
    const entries = buildSlashPermissionMetadata();

    expect(entries.length).toBeGreaterThan(0);
    const names = entries.map((entry) => entry.commandName);
    expect(names).toEqual([...names].sort());

    for (const entry of entries) {
      expect(entry.defaultMemberPermissions).toBe(defaultMemberPermissionsFor(entry.level));
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("renders a markdown table with a header row and one body row per command", () => {
    const entries = buildSlashPermissionMetadata();
    const markdown = renderSlashPermissionMarkdown(entries);

    expect(markdown.startsWith("| command |")).toBe(true);
    expect(markdown).toContain("| --- |");
    expect(markdown.split("\n").length).toBe(entries.length + 2);

    for (const entry of entries) {
      expect(markdown).toContain(`\`/${entry.commandName}\``);
      expect(markdown).toContain(entry.level);
    }
  });

  it("accepts a precomputed entry list (lets callers override the snapshot)", () => {
    const markdown = renderSlashPermissionMarkdown([
      {
        commandName: "example",
        level: "manage_messages",
        defaultMemberPermissions: defaultMemberPermissionsFor("manage_messages"),
        reason: "doc example",
      },
    ]);

    expect(markdown).toContain("`/example`");
    expect(markdown).toContain("manage_messages");
  });
});

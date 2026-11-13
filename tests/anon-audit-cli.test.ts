import { describe, expect, it, vi } from "vitest";
import type { AnonAuditDeleteResult } from "../src/features/anonymous-chat/audit-delete.js";
import type { AnonAuditLookupResult } from "../src/features/anonymous-chat/audit-lookup.js";
import type { AnonAuditOperation } from "../src/features/anonymous-chat/audit-ops.js";
import { runAnonAuditDelete } from "../src/scripts/anon-audit-delete.js";
import { runAnonAuditLookup } from "../src/scripts/anon-audit-lookup.js";

const LOOKUP_ARGV = ["--key-file", "key.pem", "--dir", "data/anon-audit", "--message", "msg-1"];
const DELETE_ARGV = ["--key-file", "key.pem", "--dir", "data/anon-audit", "--user", "user-1"];

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      stdout: (t: string) => stdout.push(t),
      stderr: (t: string) => stderr.push(t),
      readKeyFile: async () => "pem",
    },
  };
}

const okLookupResult: AnonAuditLookupResult = {
  ok: true,
  scanned: 5,
  matched: [
    {
      file: "2026-01-01.jsonl",
      plaintext: {
        v: 2,
        kind: "posted",
        attemptId: "a".repeat(32),
        messageId: "msg-1",
        userId: "user-9",
        guildId: "g",
        channelId: "c",
        postedAt: "t",
      },
    },
  ],
  unmatchedAttempts: [],
};

const okDeleteResult: AnonAuditDeleteResult = {
  ok: true,
  scanned: 5,
  removed: 2,
};

describe("runAnonAuditLookup — mandatory operation record", () => {
  it("aborts before decryption when the start record cannot be written", async () => {
    const { stdout, stderr, deps } = io();
    const lookup = vi.fn(async () => okLookupResult);
    const code = await runAnonAuditLookup(LOOKUP_ARGV, {
      ...deps,
      appendOperation: async () => {
        throw new Error("disk full");
      },
      lookup,
    });
    expect(code).toBe(1);
    expect(lookup).not.toHaveBeenCalled();
    expect(stdout).toHaveLength(0);
    expect(stderr.join("\n")).toContain("operation log unavailable");
  });

  it("withholds decrypted results when the end record cannot be written", async () => {
    const { stdout, stderr, deps } = io();
    const lookup = vi.fn(async () => okLookupResult);
    const appendOperation = vi.fn(async (dir: string, entry: AnonAuditOperation): Promise<void> => {
      void dir;
      void entry;
      throw new Error("disk full");
    });
    appendOperation.mockResolvedValueOnce(undefined); // start succeeds; end uses default → throws
    const code = await runAnonAuditLookup(LOOKUP_ARGV, {
      ...deps,
      appendOperation,
      lookup,
    });
    expect(code).toBe(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    // Disclosure gate: no plaintext line may reach stdout.
    expect(stdout).toHaveLength(0);
    expect(stdout.join("\n")).not.toContain("user-9");
    expect(stderr.join("\n")).toContain("results withheld");
    // Both phases were attempted; the end append is the one that
    // failed — disclosure was withheld rather than completing
    // unrecorded.
    expect(appendOperation.mock.calls.map((c) => c[1].phase)).toEqual(["start", "end"]);
  });

  it("writes start then end records and prints results on success", async () => {
    const { stdout, deps } = io();
    const appendOperation = vi.fn(async (dir: string, entry: AnonAuditOperation): Promise<void> => {
      void dir;
      void entry;
      return undefined;
    });
    const lookup = vi.fn(async () => okLookupResult);
    const code = await runAnonAuditLookup(LOOKUP_ARGV, {
      ...deps,
      appendOperation,
      lookup,
    });
    expect(code).toBe(0);
    expect(appendOperation).toHaveBeenCalledTimes(2);
    expect(appendOperation.mock.calls[0]?.[1]).toMatchObject({
      op: "lookup",
      phase: "start",
      keys: 1,
    });
    expect(appendOperation.mock.calls[1]?.[1]).toMatchObject({
      op: "lookup",
      phase: "end",
      scanned: 5,
      results: 1,
    });
    // The ops entries must never carry query values or plaintext.
    for (const call of appendOperation.mock.calls) {
      expect(JSON.stringify(call[1])).not.toContain("user-9");
      expect(JSON.stringify(call[1])).not.toContain("msg-1");
    }
    expect(stdout.join("\n")).toContain('"userId":"user-9"');
  });

  it("does not decrypt until the start record is durable", async () => {
    const { deps } = io();
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const appendOperation = vi.fn(async (dir: string, entry: AnonAuditOperation) => {
      void dir;
      if (entry.phase === "start") {
        await startGate;
      }
    });
    const lookup = vi.fn(async () => okLookupResult);
    const pending = runAnonAuditLookup(LOOKUP_ARGV, {
      ...deps,
      appendOperation,
      lookup,
    });
    await vi.waitFor(() => expect(appendOperation).toHaveBeenCalledTimes(1));
    // Start append still pending → decryption must not have run.
    expect(lookup).not.toHaveBeenCalled();
    releaseStart?.();
    expect(await pending).toBe(0);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("withholds stdout until the end record is durable", async () => {
    const { stdout, deps } = io();
    let releaseEnd: (() => void) | undefined;
    const endGate = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    const appendOperation = vi.fn(async (dir: string, entry: AnonAuditOperation) => {
      void dir;
      if (entry.phase === "end") {
        await endGate;
      }
    });
    const pending = runAnonAuditLookup(LOOKUP_ARGV, {
      ...deps,
      appendOperation,
      lookup: async () => okLookupResult,
    });
    await vi.waitFor(() =>
      expect(appendOperation.mock.calls.some((c) => c[1].phase === "end")).toBe(true),
    );
    // End append still pending → plaintext must not have been printed.
    expect(stdout).toHaveLength(0);
    releaseEnd?.();
    expect(await pending).toBe(0);
    expect(stdout.join("\n")).toContain('"userId":"user-9"');
  });

  it("returns non-zero when the lookup itself fails", async () => {
    const { stdout, deps } = io();
    const code = await runAnonAuditLookup(LOOKUP_ARGV, {
      ...deps,
      appendOperation: async () => undefined,
      lookup: async () => ({ ok: false, error: "undecryptable record" }),
    });
    expect(code).toBe(1);
    expect(stdout).toHaveLength(0);
  });
});

describe("runAnonAuditDelete — mandatory operation record", () => {
  it("never deletes when the start record cannot be written", async () => {
    const { stderr, deps } = io();
    const deleteRecords = vi.fn(async () => okDeleteResult);
    const code = await runAnonAuditDelete(DELETE_ARGV, {
      ...deps,
      appendOperation: async () => {
        throw new Error("disk full");
      },
      deleteRecords,
    });
    expect(code).toBe(1);
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain("aborted before deletion");
  });

  it("reports failure loudly when the end record fails after deletion", async () => {
    const { stdout, stderr, deps } = io();
    const deleteRecords = vi.fn(async () => okDeleteResult);
    const appendOperation = vi.fn(async (dir: string, entry: AnonAuditOperation): Promise<void> => {
      void dir;
      void entry;
      throw new Error("disk full");
    });
    appendOperation.mockResolvedValueOnce(undefined); // start succeeds; end uses default → throws
    const code = await runAnonAuditDelete(DELETE_ARGV, {
      ...deps,
      appendOperation,
      deleteRecords,
    });
    expect(code).toBe(1);
    // Deletion DID run — the failure is surfaced, not swallowed.
    expect(deleteRecords).toHaveBeenCalledTimes(1);
    expect(stdout).toHaveLength(0);
    expect(stderr.join("\n")).toContain("operation record could not be written");
  });

  it("writes start then end records on success", async () => {
    const { stdout, deps } = io();
    const appendOperation = vi.fn(async (dir: string, entry: AnonAuditOperation): Promise<void> => {
      void dir;
      void entry;
      return undefined;
    });
    const deleteRecords = vi.fn(async () => okDeleteResult);
    const code = await runAnonAuditDelete(DELETE_ARGV, {
      ...deps,
      appendOperation,
      deleteRecords,
    });
    expect(code).toBe(0);
    expect(appendOperation).toHaveBeenCalledTimes(2);
    expect(appendOperation.mock.calls[0]?.[1]).toMatchObject({
      op: "delete",
      phase: "start",
    });
    expect(appendOperation.mock.calls[1]?.[1]).toMatchObject({
      op: "delete",
      phase: "end",
      scanned: 5,
      removed: 2,
    });
    // Counts only — never the user id.
    for (const call of appendOperation.mock.calls) {
      expect(JSON.stringify(call[1])).not.toContain("user-1");
    }
    expect(stdout.join("\n")).toContain("removed=2");
  });
});

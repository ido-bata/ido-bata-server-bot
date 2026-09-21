/**
 * Static guardrail: the structured logger must replace every `console.*`
 * call in the production runtime path. This test fails if any `.ts` /
 * `.tsx` file under `src/` (outside the documented operator scripts
 * that print to stdout for human operators) invokes `console.log`,
 * `console.info`, `console.warn`, `console.error`, or `console.debug`.
 *
 * Exemptions are scoped narrowly to:
 *   - `src/scripts/**` (operator smoke scripts that legitimately print)
 *   - lines wrapped in `// allow-console: ...` annotations
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const SRC_ROOT = join(process.cwd(), "src");
const ALLOW_LINE_MARKER = "// allow-console:";
const ALLOWED_DIRS = new Set(["scripts"]);

type Violation = { file: string; line: number; code: string };

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, files);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

function isAllowed(relPath: string): boolean {
  const parts = relPath.split("/");
  return parts.length > 0 && ALLOWED_DIRS.has(parts[0]);
}

describe("observability — no console.* in src/", () => {
  it("no production module uses console.log/info/warn/error/debug", () => {
    const files = walk(SRC_ROOT);
    const violations: Violation[] = [];
    const re = /console\.(log|info|warn|error|debug)\s*\(/;
    for (const abs of files) {
      const rel = relative(SRC_ROOT, abs);
      if (isAllowed(rel)) {
        continue;
      }
      const text = readFileSync(abs, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (!re.test(line)) {
          continue;
        }
        if (line.trim().startsWith(ALLOW_LINE_MARKER)) {
          continue;
        }
        violations.push({ file: rel, line: i + 1, code: line.trim() });
      }
    }
    expect(violations).toEqual([]);
  });
});

/**
 * Static guardrail: the build must emit the entrypoint that the runtime
 * actually starts.
 *
 * The deployed configuration (Containerfile `CMD`, compose, the Altare
 * runbook) starts `node dist/index.js`. Two independent regressions can
 * break that without any unit test noticing:
 *
 *   1. `tsc` derives its common root from the files it compiles. Compiling
 *      the root `tsconfig.json` — which also includes `tests/` and
 *      `*.config.ts` — yields a repository root of `.`, so the entrypoint
 *      lands at `dist/src/index.js` and every start fails with
 *      MODULE_NOT_FOUND.
 *   2. Relative imports must point at the *emitted* file. `./tui/render.jsx`
 *      resolves under tsx (which knows the TS/TSX source) but not under
 *      `node dist/index.js`, where the emit is `render.js`.
 *
 * Both are checked statically here, so the CI job that only builds the
 * image (and never runs it) cannot let them through again.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

type BuildConfig = {
  extends?: string;
  compilerOptions?: { rootDir?: string; outDir?: string };
  include?: string[];
};

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(ROOT, file), "utf8")) as T;
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

describe("build output layout", () => {
  it("pins rootDir to src/ so the entrypoint is dist/index.js", () => {
    const config = readJson<BuildConfig>("tsconfig.build.json");
    expect(config.extends).toBe("./tsconfig.json");
    expect(config.compilerOptions?.rootDir).toBe("src");
    expect(config.compilerOptions?.outDir).toBe("dist");
    // Only `src/` may be compiled: anything else (tests/, *.config.ts)
    // widens the common root and shifts the emit to dist/src/.
    expect(config.include).toEqual(["src/**/*.ts", "src/**/*.tsx"]);
  });

  it("runs the layout-pinning config for `bun run build`", () => {
    const pkg = readJson<{ main: string; scripts: Record<string, string> }>("package.json");
    expect(pkg.scripts.build).toContain("tsconfig.build.json");
    // `main` is what Node resolves for a package entry; it must agree with
    // the file the Containerfile starts.
    expect(pkg.main).toBe("dist/index.js");
  });

  it("starts the emitted entrypoint in the Containerfile", () => {
    const containerfile = readFileSync(join(ROOT, "Containerfile"), "utf8");
    expect(containerfile).toContain('CMD ["node", "dist/index.js"]');
    // The build stage must copy the layout-pinning config, otherwise the
    // RUN has no tsconfig.build.json to compile with.
    expect(containerfile).toContain("COPY tsconfig.json tsconfig.build.json ./");
  });
});

describe("relative imports resolve to emitted files", () => {
  it("never imports a .jsx / .ts / .tsx extension from src/", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from\s+"(\.[^"]*)"/g)) {
        const specifier = match[1] ?? "";
        // NodeNext emits `.js` for `.ts`/`.tsx` sources; a source-relative
        // extension only resolves under tsx, never under `node dist/...`.
        if (/\.(jsx|tsx|ts)$/.test(specifier)) {
          offenders.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

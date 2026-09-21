import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntimeStatusStore } from "../../src/runtime/status-store.js";
import { isInteractive, type mountTui, resolveTuiMode } from "../../src/tui/render.js";

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    BOT_TUI: undefined,
    TERM: "xterm-256color",
    CI: undefined,
    ...overrides,
  };
}

describe("isInteractive", () => {
  const originalStdout = process.stdout.isTTY;
  const originalStdin = process.stdin.isTTY;
  const originalTerm = process.env.TERM;
  const originalCi = process.env.CI;

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdout,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdin,
      configurable: true,
      writable: true,
    });
    if (originalTerm === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = originalTerm;
    }
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
  });

  function setTty(stdout: boolean | undefined, stdin: boolean | undefined): void {
    Object.defineProperty(process.stdout, "isTTY", {
      value: stdout,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: stdin,
      configurable: true,
      writable: true,
    });
  }

  it("returns true for a full TTY environment", () => {
    setTty(true, true);
    delete process.env.CI;
    process.env.TERM = "xterm-256color";
    expect(isInteractive(process.env)).toBe(true);
  });

  it("returns false when stdout is not a TTY", () => {
    setTty(false, true);
    delete process.env.CI;
    process.env.TERM = "xterm-256color";
    expect(isInteractive(process.env)).toBe(false);
  });

  it("returns false when stdin is not a TTY", () => {
    setTty(true, false);
    delete process.env.CI;
    process.env.TERM = "xterm-256color";
    expect(isInteractive(process.env)).toBe(false);
  });

  it("returns false when CI=true", () => {
    setTty(true, true);
    process.env.CI = "true";
    process.env.TERM = "xterm-256color";
    expect(isInteractive(process.env)).toBe(false);
  });

  it("returns false when TERM=dumb", () => {
    setTty(true, true);
    delete process.env.CI;
    process.env.TERM = "dumb";
    expect(isInteractive(process.env)).toBe(false);
  });
});

describe("resolveTuiMode", () => {
  it("'on' is literal", () => {
    expect(resolveTuiMode(baseEnv({ BOT_TUI: "on" }))).toBe("on");
  });

  it("'off' is literal", () => {
    expect(resolveTuiMode(baseEnv({ BOT_TUI: "off" }))).toBe("off");
  });

  it("'auto' resolves to 'on' when interactive", () => {
    const originalStdout = process.stdout.isTTY;
    const originalStdin = process.stdin.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      expect(
        resolveTuiMode(baseEnv({ BOT_TUI: "auto", TERM: "xterm-256color", CI: undefined })),
      ).toBe("on");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: originalStdout,
        configurable: true,
      });
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalStdin,
        configurable: true,
      });
    }
  });

  it("'auto' resolves to 'off' when non-interactive", () => {
    const originalStdout = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    try {
      expect(
        resolveTuiMode(baseEnv({ BOT_TUI: "auto", TERM: "xterm-256color", CI: undefined })),
      ).toBe("off");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: originalStdout,
        configurable: true,
      });
    }
  });

  it("unknown values fall back to 'off'", () => {
    expect(resolveTuiMode(baseEnv({ BOT_TUI: "maybe" }))).toBe("off");
    expect(resolveTuiMode(baseEnv({ BOT_TUI: "garbage" }))).toBe("off");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveTuiMode(baseEnv({ BOT_TUI: "  ON  " }))).toBe("on");
    expect(resolveTuiMode(baseEnv({ BOT_TUI: "Off" }))).toBe("off");
  });

  it("treats unset BOT_TUI as 'auto'", () => {
    expect(resolveTuiMode(baseEnv({ BOT_TUI: undefined }))).toMatch(/^(on|off)$/);
  });
});

describe("mountTui", () => {
  const originalStdout = process.stdout.isTTY;
  const originalStdin = process.stdin.isTTY;
  const originalTerm = process.env.TERM;
  const originalCi = process.env.CI;

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdout,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdin,
      configurable: true,
      writable: true,
    });
    if (originalTerm === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = originalTerm;
    }
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
  });

  it("returns null when BOT_TUI=off without invoking render", async () => {
    const renderSpy = vi.fn();
    const store = createRuntimeStatusStore();
    // Mount with BOT_TUI=off and an injected render to confirm it is
    // not called. We test the resolve+gate path by calling mountTui
    // directly with explicit env.
    const instance = await mountTuiWithInjectedRender(store, renderSpy, {
      BOT_TUI: "off",
      TERM: "xterm-256color",
      CI: undefined,
    });
    expect(instance).toBeNull();
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("returns null when BOT_TUI=auto and the env is non-interactive", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
      writable: true,
    });
    const renderSpy = vi.fn();
    const store = createRuntimeStatusStore();
    const instance = await mountTuiWithInjectedRender(store, renderSpy, {
      BOT_TUI: "auto",
      TERM: "xterm-256color",
      CI: undefined,
    });
    expect(instance).toBeNull();
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("returns null in CI environment", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
    const renderSpy = vi.fn();
    const store = createRuntimeStatusStore();
    const instance = await mountTuiWithInjectedRender(store, renderSpy, {
      BOT_TUI: "auto",
      TERM: "xterm-256color",
      CI: "true",
    });
    expect(instance).toBeNull();
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("returns null when TERM=dumb", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
    const renderSpy = vi.fn();
    const store = createRuntimeStatusStore();
    const instance = await mountTuiWithInjectedRender(store, renderSpy, {
      BOT_TUI: "auto",
      TERM: "dumb",
      CI: undefined,
    });
    expect(instance).toBeNull();
    expect(renderSpy).not.toHaveBeenCalled();
  });
});

/**
 * Call mountTui with a render spy injected via module mocking. We
 * re-import the render module after mocking so the local reference to
 * `render` is replaced with the spy.
 */
async function mountTuiWithInjectedRender(
  store: ReturnType<typeof createRuntimeStatusStore>,
  renderSpy: ReturnType<typeof vi.fn>,
  env: NodeJS.ProcessEnv,
): Promise<ReturnType<typeof mountTui>> {
  vi.resetModules();
  vi.doMock("ink", () => ({
    render: renderSpy.mockImplementation(() => {
      const stdout = new PassThrough();
      const stdin = new PassThrough();
      return {
        waitUntilExit: () => new Promise(() => undefined),
        unmount: () => undefined,
        cleanup: () => undefined,
        stdout,
        stdin,
        rerender: () => undefined,
      };
    }),
  }));
  const mod = await import("../../src/tui/render.jsx");
  // Restore `process.env` controls for `resolveTuiMode`.
  return mod.mountTui(store, {
    env,
    stdout: new PassThrough() as unknown as NodeJS.WriteStream,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
  });
}

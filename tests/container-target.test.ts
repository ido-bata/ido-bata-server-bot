import { describe, expect, it } from "vitest";

import {
  CONTAINER_TARGETS,
  type ContainerTarget,
  DEFAULT_CONTAINER_TARGET,
  describeContainerTarget,
  resolveContainerTarget,
  resolveContainerTargetOr,
} from "../src/features/container/index.js";

describe("CONTAINER_TARGETS", () => {
  it("matches the three stages declared by the Containerfile", () => {
    expect(CONTAINER_TARGETS).toEqual(["deps", "build", "runtime"]);
  });

  it("uses `runtime` as the default build target", () => {
    expect(DEFAULT_CONTAINER_TARGET).toBe("runtime");
  });
});

describe("resolveContainerTarget", () => {
  it("returns the matching target for known names", () => {
    for (const target of CONTAINER_TARGETS) {
      expect(resolveContainerTarget(target)).toBe<ContainerTarget>(target);
    }
  });

  it("trims surrounding whitespace before matching", () => {
    expect(resolveContainerTarget("  runtime  ")).toBe("runtime");
    expect(resolveContainerTarget("\tbuild\n")).toBe("build");
  });

  it("returns null for unknown / empty / non-string input", () => {
    expect(resolveContainerTarget(undefined)).toBeNull();
    expect(resolveContainerTarget(null)).toBeNull();
    expect(resolveContainerTarget("")).toBeNull();
    expect(resolveContainerTarget("   ")).toBeNull();
    expect(resolveContainerTarget("prod")).toBeNull();
    expect(resolveContainerTarget("RUNTIME")).toBeNull();
    expect(resolveContainerTarget("runtime;rm")).toBeNull();
  });
});

describe("resolveContainerTargetOr", () => {
  it("falls back to the default when input is unknown", () => {
    expect(resolveContainerTargetOr(undefined)).toBe(DEFAULT_CONTAINER_TARGET);
    expect(resolveContainerTargetOr(null)).toBe(DEFAULT_CONTAINER_TARGET);
    expect(resolveContainerTargetOr("")).toBe(DEFAULT_CONTAINER_TARGET);
    expect(resolveContainerTargetOr("unknown")).toBe(DEFAULT_CONTAINER_TARGET);
  });

  it("honors an explicit fallback", () => {
    expect(resolveContainerTargetOr(undefined, "build")).toBe("build");
    expect(resolveContainerTargetOr("prod", "deps")).toBe("deps");
  });

  it("does not override a valid target with the fallback", () => {
    expect(resolveContainerTargetOr("runtime", "build")).toBe("runtime");
    expect(resolveContainerTargetOr("  build  ", "runtime")).toBe("build");
  });
});

describe("describeContainerTarget", () => {
  it("labels every target so CI logs are actionable", () => {
    const descriptions = CONTAINER_TARGETS.map(describeContainerTarget);
    for (const description of descriptions) {
      expect(description).toMatch(/^[a-z]+ — /);
    }
  });

  it("mentions the role of each stage in the description", () => {
    expect(describeContainerTarget("deps")).toContain("deps");
    expect(describeContainerTarget("build")).toContain("dist");
    expect(describeContainerTarget("runtime")).toContain("runtime");
  });
});

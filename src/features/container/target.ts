/**
 * Build target metadata for the `Containerfile`.
 *
 * The Containerfile exposes three named stages — `deps`, `build`, `runtime`
 * — each of which is addressable as a build target. CI and `docker compose`
 * must agree on the canonical names so that a smoke build on one platform
 * matches what contributors get on another. Keeping the names in a single
 * source of truth lets the TypeScript side assert against typos before the
 * daemon is invoked.
 */
export const CONTAINER_TARGETS = ["deps", "build", "runtime"] as const;

export type ContainerTarget = (typeof CONTAINER_TARGETS)[number];

/**
 * The compose service uses `runtime` by default — anything else is a
 * misconfiguration and would silently produce a container without
 * `dist/index.js`. We expose the default so scripts (CI smoke, future
 * multi-arch builds) don't have to hardcode the name.
 */
export const DEFAULT_CONTAINER_TARGET: ContainerTarget = "runtime";

/**
 * Coerce arbitrary input — CLI args, env vars, or a literal — into a known
 * container build target.
 *
 * Returns `null` for `undefined` / empty / unknown values so callers can
 * pick a fallback without silently accepting typos. `resolveContainerTarget`
 * never throws.
 */
export function resolveContainerTarget(value: string | undefined | null): ContainerTarget | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if ((CONTAINER_TARGETS as readonly string[]).includes(trimmed)) {
    return trimmed as ContainerTarget;
  }

  return null;
}

/**
 * Convenience wrapper for the "give me a target, falling back to a default"
 * pattern. Used by the CI smoke step and any future scripting that needs
 * to pass the target through `process.env` or argv without losing the
 * default on `undefined`.
 */
export function resolveContainerTargetOr(
  value: string | undefined | null,
  fallback: ContainerTarget = DEFAULT_CONTAINER_TARGET,
): ContainerTarget {
  return resolveContainerTarget(value) ?? fallback;
}

/**
 * Human-readable description used by the CI smoke step and `bun run
 * container:print`. Tests assert the wording matches what the docs and
 * Containerfile comments promise.
 */
export function describeContainerTarget(target: ContainerTarget): string {
  switch (target) {
    case "deps":
      return "deps — install production dependencies via bun";
    case "build":
      return "build — compile TypeScript to dist/";
    case "runtime":
      return "runtime — slim Node image with dist/ and node_modules";
  }
}

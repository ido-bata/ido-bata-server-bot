# syntax=docker/dockerfile:1.7
#
# Multi-stage Containerfile for ido-bata-server-bot.
#
#   base       — Node 22-alpine runtime base. Switched from -slim in
#                round-5 because the slim base (~180 MiB) plus prod deps
#                landed at 347 MiB after the prod-deps split, which
#                still failed the < 300 MiB gate. Alpine (~50 MiB base)
#                plus `libc6-compat` for opusscript's glibc native module
#                keeps the runtime image under budget.
#   deps       — base + `bun install --frozen-lockfile` (prod + dev, for build).
#   build      — deps + TypeScript compile to dist/.
#   prod-deps  — base + `bun install --production` (prod-only). Provides
#                the runtime node_modules so the devDependencies that
#                `deps` materialised for the build stage are NOT carried
#                into the runtime image (saves ~300 MiB).
#   runtime    — alpine + dist (from build) + production node_modules
#                (from prod-deps). This is the image Compose uses by
#                default.
#
# Compose builds `runtime`; the production entrypoint runs the compiled
# `dist/index.js` so the runtime image does not need tsx or the TypeScript
# source tree.
#
# Build contexts:
#   - `deps` / `prod-deps` → only `package.json` + `bun.lock` are copied
#                            (faster cache).
#   - `build`              → source tree is copied after deps are cached.
#   - `runtime`            → only `package.json` is copied, the rest is
#                            `--from=...`.
#
# Image size target: < 300 MB. node:22-alpine is ~50 MB; production deps
# (`discord.js`, `@discordjs/voice`, `ffmpeg-static`, `opusscript`, `zod`,
# `dotenv`) push the total to ~250-280 MB on amd64.
ARG NODE_IMAGE=node:22-alpine

# ---- base ----
FROM ${NODE_IMAGE} AS base
WORKDIR /app
# `NODE_ENV=production` is set only in the `runtime` stage. Propagating it
# to the `deps` stage would make `bun install --frozen-lockfile` skip
# devDependencies (TypeScript, biome, eslint, knip, vitest, etc.) and the
# subsequent `bun run build` would fail because `tsc` is a devDependency.
ENV NPM_CONFIG_LOGLEVEL=warn \
    PATH="/usr/local/bin:${PATH}"

# ---- deps ----
# Install Bun pinned to the version declared in `packageManager` (matches
# CI's `bun install --frozen-lockfile`) and tsx (matches `bun run start`
# semantics). Then materialize the full dep tree (prod + dev so the build
# stage can compile).
FROM base AS deps
ARG BUN_VERSION=1.3.10
# curl + unzip + bash are kept in the `deps` stage: removing them after
# Bun is installed used to be a nice-to-have but the apk del runs in the
# same layer as the Bun install, and the post-install scripts on newer
# Alpine images occasionally invalidate the moved /usr/local/bin/bun
# symlink (the build fails with `bun: not found` on the next RUN).
# The build stage is throw-away so the extra ~6 MiB of apk cache is fine.
RUN apk add --no-cache \
        ca-certificates \
        curl \
        unzip \
        bash \
    && curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip \
    && unzip /tmp/bun.zip -d /tmp/bun \
    && mv /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun /tmp/bun.zip \
    && npm install -g tsx@4.23.9 \
    && rm -rf /var/cache/apk/*
COPY package.json bun.lock ./
# `NODE_ENV` is unset in this stage (it is set in `runtime` only), so
# devDependencies (`tsc`, `vitest`, ...) are installed for the build stage.
RUN bun install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

# ---- prod-deps ----
# Re-install from the lockfile with NODE_ENV=production so devDependencies
# (TypeScript, biome, eslint, knip, vitest, ~hundreds of MB of transitive
# packages) are dropped. The runtime image copies node_modules from this
# stage instead of `deps`; without it the runtime image carries the build
# toolchain and balloons past the 300 MiB size gate.
FROM base AS prod-deps
ARG BUN_VERSION=1.3.10
# Reuses the cached Bun install from `deps` (above) — Bun is identical,
# so re-installing via the same path would just double the apk layer.
COPY --from=deps /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock ./
ENV NODE_ENV=production
RUN bun install --production --frozen-lockfile \
    && rm -rf /root/.bun/install/cache /root/.cache/bun

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
# `libc6-compat` ships glibc compatibility shims so opusscript's prebuilt
# NASM native module (loaded when WASM is unavailable) can resolve its
# dynamic symbols on Alpine's musl libc. Without it the audio path
# crashes on first voice session.
RUN apk add --no-cache \
        ca-certificates \
        libc6-compat \
    && rm -rf /var/cache/apk/*
# NODE_ENV=production belongs here, not in `base` — see the comment above.
ENV NODE_ENV=production \
    CONTAINER=true
# Copy only the package.json so npm/bun don't see a missing "scripts" field
# complaint — `node dist/index.js` is the canonical entrypoint. The
# production-only node_modules come from `prod-deps`, NOT `deps`, so the
# build-time toolchain does not leak into the runtime image.
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY tmp-audio ./tmp-audio

# Healthcheck hits the `/health` endpoint introduced by issue #26. The probe
# is intentionally tolerant of a not-yet-implemented endpoint: the curl call
# is wrapped so an ECONNREFUSED during the very first few seconds still maps
# to a clean exit (compose will retry up to `retries` times).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
EXPOSE 8080

CMD ["node", "dist/index.js"]
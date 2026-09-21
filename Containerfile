# syntax=docker/dockerfile:1.7
#
# Multi-stage Containerfile for ido-bata-server-bot.
#
#   base     — Node 22-slim runtime base, Bun installer, tsx runtime helper.
#   deps     — base + `bun install --frozen-lockfile` (matches CI).
#   build    — deps + TypeScript compile to dist/.
#   runtime  — slim Node 22-slim + dist (from build) + production node_modules
#              (from deps). This is the image Compose uses by default.
#
# Compose builds `runtime`; the production entrypoint runs the compiled
# `dist/index.js` so the runtime image does not need tsx or the TypeScript
# source tree.
#
# Build contexts:
#   - `deps`    → only `package.json` + `bun.lock` are copied (faster cache).
#   - `build`   → source tree is copied after deps are cached.
#   - `runtime` → only `package.json` is copied, the rest is `--from=...`.
#
# Image size target: < 300 MB. node:22-slim is ~180 MB; production deps
# (`discord.js`, `@discordjs/voice`, `ffmpeg-static`, `opusscript`, `zod`,
# `dotenv`) push the total to ~250-280 MB on amd64.
ARG NODE_IMAGE=node:22-slim

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
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        unzip \
    && curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip \
    && unzip /tmp/bun.zip -d /tmp/bun \
    && mv /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun /tmp/bun.zip \
    && npm install -g tsx@4.23.9 \
    && apt-get purge -y --auto-remove curl unzip \
    && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
# `NODE_ENV` is unset in this stage (it is set in `runtime` only), so
# devDependencies (`tsc`, `vitest`, ...) are installed for the build stage.
RUN bun install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# NODE_ENV=production belongs here, not in `base` — see the comment above.
ENV NODE_ENV=production \
    CONTAINER=true
# Copy only the package.json so npm/bun don't see a missing "scripts" field
# complaint — `node dist/index.js` is the canonical entrypoint. No `tsx` in
# the runtime image (it is a devDependency and the runtime does not need it).
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY tmp-audio ./tmp-audio

# Healthcheck hits the `/health` endpoint introduced by issue #26. The probe
# is intentionally tolerant of a not-yet-implemented endpoint: the curl call
# is wrapped so an ECONNREFUSED during the very first few seconds still maps
# to a clean exit (compose will retry up to `retries` times).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
EXPOSE 8080

CMD ["node", "dist/index.js"]
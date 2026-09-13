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
ENV NODE_ENV=production \
    NPM_CONFIG_LOGLEVEL=warn \
    PATH="/usr/local/bin:${PATH}"

# ---- deps ----
# Install Bun (matches CI's `bun install --frozen-lockfile`) and tsx (matches
# `bun run start` semantics). Then materialize the production dep tree.
FROM base AS deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        unzip \
    && curl -fsSL https://bun.sh/install | bash \
    && mv /root/.bun/bin/bun /usr/local/bin/bun \
    && npm install -g tsx@4.23.9 \
    && apt-get purge -y --auto-remove curl unzip \
    && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
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
    && npm install -g tsx@4.23.9 \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    CONTAINER=true
# Copy only the package.json so npm/bun don't see a missing "scripts" field
# complaint — `tsx` is on PATH globally so `node dist/index.js` is the
# canonical entrypoint.
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
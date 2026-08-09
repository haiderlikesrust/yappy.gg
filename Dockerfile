# syntax=docker/dockerfile:1

## yappy.gg backend — one image, three services.
##
## The api, gateway and worker share a codebase, a dependency tree and a build.
## Publishing three near-identical images would triple build time and registry
## storage to express a difference that is one command line long, so they are
## the same image started with different arguments. `docker-compose.prod.yml`
## picks which.
##
## Multi-stage, so the shipped image contains no compiler, no dev dependencies
## and no source — just `dist/` and production `node_modules`.

# ─── deps ─────────────────────────────────────────────────────────────────────
# Split from the build so a source-only change reuses the install layer. Every
# workspace package.json is copied *before* the sources for exactly that reason:
# pnpm needs the whole manifest set to resolve a workspace, but those files
# change far less often than the code.
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/gateway/package.json apps/gateway/
COPY apps/worker/package.json apps/worker/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# ─── build ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/apps/gateway/node_modules ./apps/gateway/node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY . .

# Packages before apps: the apps import the packages' emitted .d.ts files.
RUN pnpm build

# ─── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
RUN corepack enable
WORKDIR /app

ENV NODE_ENV=production

# A second, production-only install rather than pruning the build's tree:
# `--prod` here resolves the workspace links correctly and leaves nothing of
# TypeScript, tsx or the test tooling behind.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/gateway/package.json apps/gateway/
COPY apps/worker/package.json apps/worker/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --prod

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=build /app/apps/worker/dist ./apps/worker/dist

# The migration runner reads these at runtime from `packages/db/{sql,migrations}`
# — it resolves them relative to its own compiled location, so the layout has to
# match the source tree rather than being flattened.
COPY --from=build /app/packages/db/sql ./packages/db/sql
COPY --from=build /app/packages/db/migrations ./packages/db/migrations

# Operator scripts, run with `docker compose run --rm api node <script>`:
# creating the yapper bot, setting its avatar, granting badges. Plain .mjs on
# purpose — they are administration, not application, and shipping them here is
# what makes the bot seedable on a VPS at all. The icon is the avatar source,
# at the path the script resolves relative to itself.
COPY --from=build /app/packages/db/scripts ./packages/db/scripts
COPY --from=build /app/apps/api/scripts ./apps/api/scripts
COPY --from=build /app/web/icon.png ./web/icon.png

# Node's own user, so nothing runs as root.
USER node

# Overridden per service in compose. The api is the sensible default for anyone
# running the image directly. Environment comes from the container, so unlike
# the `start` scripts there is no .env to load.
CMD ["node", "apps/api/dist/main.js"]

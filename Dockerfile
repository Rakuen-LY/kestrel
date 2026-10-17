# syntax=docker/dockerfile:1

# ---- build -----------------------------------------------------------------
FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @kestrel/server... build
RUN pnpm --filter "./plugins/**" build
RUN pnpm --filter @kestrel/web build

# ---- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# The agent shells out to git and curl; keep the image useful out of the box.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    KESTREL_HOST=0.0.0.0 \
    KESTREL_PORT=7331 \
    KESTREL_WORKSPACE=/workspace \
    KESTREL_DATA_DIR=/data \
    KESTREL_PLUGINS=plugins,examples/plugins

WORKDIR /app

# The server bundle inlines every workspace package; plugins are self-contained ESM.
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/plugins ./plugins
COPY --from=build --chown=node:node /app/examples ./examples

RUN mkdir -p /workspace /data && chown -R node:node /workspace /data
USER node

EXPOSE 7331
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7331/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/server/dist/bin.js"]

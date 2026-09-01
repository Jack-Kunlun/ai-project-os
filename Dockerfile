FROM node:24.19.0-bookworm-slim AS base

LABEL org.opencontainers.image.title="AI Project OS" \
      org.opencontainers.image.version="0.1.0-dev.1"

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates git openssh-client openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack install --global pnpm@10.14.0

WORKDIR /app

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS builder

# Prisma config is evaluated during generate; use a non-secret build-only URL.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build"
ENV NEXT_TELEMETRY_DISABLED=1

COPY . .
RUN pnpm db:generate
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm build

FROM base AS migrate

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/prisma.config.ts ./prisma.config.ts

USER node

CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "prisma.config.ts"]

FROM deps AS worker

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV AI_PROJECT_OS_MASTER_KEY_FILE=/var/lib/ai-project-os-secrets/master.key
# Prisma evaluates its config during generation; Compose replaces this
# non-secret build-only URL with the real runtime connection.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build"

COPY . .
RUN pnpm db:generate
RUN mkdir -p /var/lib/ai-project-os-secrets /var/lib/ai-project-os/uploads \
  && chown -R node:node /var/lib/ai-project-os-secrets /var/lib/ai-project-os/uploads /app

USER node

CMD ["node", "node_modules/tsx/dist/cli.mjs", "scripts/automation-worker.ts"]

FROM base AS runner

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000

COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

RUN mkdir -p /var/lib/ai-project-os-secrets /var/lib/ai-project-os/uploads \
  && chown node:node /var/lib/ai-project-os-secrets /var/lib/ai-project-os/uploads

USER node

EXPOSE 3000

CMD ["node", "server.js"]

FROM node:24.19.0-bookworm-slim

LABEL org.opencontainers.image.title="AI Project OS isolated web browser prototype" \
      org.opencontainers.image.version="0.7.0-dev.1" \
      io.ai-project-os.web-browser-contract="0.7.0-dev.1-s1b-prototype"

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV PLAYWRIGHT_BROWSERS_PATH="/ms-playwright"

RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack install --global pnpm@10.14.0

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
RUN mkdir -p /ms-playwright /run/web-browser /run/web-browser-output \
  && pnpm exec playwright install --with-deps chromium

COPY src/lib/web-browser-egress-proxy.ts src/lib/web-browser-policy.ts src/lib/web-browser-visible-text.ts ./src/lib/
COPY scripts/web-browser-container.ts ./scripts/

RUN chown -R node:node /app /ms-playwright /run/web-browser /run/web-browser-output

USER node

ENTRYPOINT ["node", "--import", "tsx", "scripts/web-browser-container.ts"]

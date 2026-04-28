FROM node:22-bookworm-slim

# Install curl and unzip (not included in slim image, required for Bun installer)
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      curl ca-certificates unzip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Install Bun (required for build scripts) — version-pinned for reproducible builds
ENV BUN_VERSION=1.3.11
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
# Must run after pnpm install so playwright-core is available in node_modules.
ARG OPENCLAW_INSTALL_BROWSER=""
RUN if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
      node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

# Optionally install signal-cli native binary for Signal channel support.
# Build with: docker build --build-arg OPENCLAW_INSTALL_SIGNAL_CLI=1 ...
# Adds ~150MB but enables native signal-cli daemon inside the container.
ARG OPENCLAW_INSTALL_SIGNAL_CLI=""
ARG SIGNAL_CLI_VERSION="0.14.1"
# NOTE: signal-cli releases do not include checksum files (.sha256, .sha512),
# so integrity verification is limited to HTTPS transport security.
RUN if [ -n "$OPENCLAW_INSTALL_SIGNAL_CLI" ]; then \
      ARCH=$(dpkg --print-architecture) && \
      if [ "$ARCH" = "amd64" ]; then ARCH_LABEL="Linux-native"; \
      elif [ "$ARCH" = "arm64" ]; then ARCH_LABEL="Linux-native-aarch64"; \
      else echo "Unsupported arch: $ARCH" && exit 1; fi && \
      curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-${ARCH_LABEL}.tar.gz" \
        -o /tmp/signal-cli.tar.gz && \
      tar xf /tmp/signal-cli.tar.gz -C /usr/local/bin/ && \
      chmod +x /usr/local/bin/signal-cli && \
      rm /tmp/signal-cli.tar.gz && \
      signal-cli --version; \
    fi

COPY . .
# Re-run pnpm install now that workspace package.json files are present.
# The earlier install only saw the root + ui packages, so workspace deps
# (e.g. extensions/claude-gateway → js-yaml) had no node_modules symlinks.
# CI=true silences pnpm's interactive prompt about removing modules.
ENV CI=true
RUN pnpm install --frozen-lockfile --prefer-offline
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# Security hardening: Run as non-root user
# The node:22-bookworm-slim image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]

# ── Stage 1: build environment ──
FROM node:18-slim AS builder

WORKDIR /app

# Copy package files first (for better layer caching)
COPY package.json package-lock.json* ./

# Install dependencies (production only, ignore optional deps to reduce size)
RUN npm ci --only=production --no-audit --no-fund --ignore-scripts \
    && npm cache clean --force \
    && rm -rf /tmp/*

# Copy source files
COPY bot_entry.js bot_entry_v2.js healthcheck.js audio-worklet.js google_auth_state.json ./
COPY lib/ ./lib/
COPY platforms/ ./platforms/

# Install Playwright Chromium only (headless mode)
# Note: --with-deps installs system deps, but we'll remove GUI libs in runtime stage
RUN npx playwright install chromium \
    && mv /root/.cache/ms-playwright /ms-playwright \
    && rm -rf /root/.cache /tmp/*

# Aggressively clean node_modules to reduce size
RUN find node_modules -type f \( \
        -name "*.map" -o \
        -name "*.ts" -o \
        -name "*.md" -o \
        -name "*.txt" -o \
        -name "*.yml" -o \
        -name "*.yaml" -o \
        -name "CHANGELOG*" -o \
        -name "LICENSE*" -o \
        -name "README*" -o \
        -name ".npmignore" -o \
        -name ".gitignore" \
    \) -delete \
    && find node_modules -type d \( \
        -name "test" -o \
        -name "tests" -o \
        -name "__tests__" -o \
        -name "examples" -o \
        -name ".github" -o \
        -name "docs" -o \
        -name "doc" -o \
        -name "coverage" -o \
        -name ".nyc_output" \
    \) -exec rm -rf {} + 2>/dev/null || true \
    && rm -rf node_modules/.cache node_modules/.bin/*.cmd node_modules/.bin/*.ps1 2>/dev/null || true

# ── Stage 2: production image ──
FROM node:18-slim

WORKDIR /app

# Install runtime dependencies for Playwright headless mode
# GPU acceleration libraries (mesa) for smoother rendering
# Full sound stack (pulseaudio, alsa) for WebRTC compatibility
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 \
      libatk-bridge2.0-0 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxrandr2 \
      libgbm1 \
      libxss1 \
      libasound2 \
      libxfixes3 \
      libxshmfence1 \
      libxcb1 \
      libx11-6 \
      libx11-xcb1 \
      libxext6 \
      libxrender1 \
      ca-certificates \
      # Required for Chromium/Playwright (CUPS printing support)
      libcups2 \
      # GPU acceleration libraries (mesa)
      libgl1-mesa-dri \
      libgl1-mesa-glx \
      # Full sound stack for WebRTC
      pulseaudio \
      alsa-utils \
      libpulse0 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
    && rm -rf /usr/share/doc /usr/share/man /usr/share/locale /usr/share/info

# Copy only essential files from builder
COPY --from=builder --chown=1000:1000 /app/node_modules /app/node_modules
COPY --from=builder --chown=1000:1000 /app/bot_entry.js /app/bot_entry_v2.js /app/healthcheck.js /app/audio-worklet.js /app/google_auth_state.json /app/
COPY --from=builder --chown=1000:1000 /app/lib /app/lib
COPY --from=builder --chown=1000:1000 /app/platforms /app/platforms
COPY --from=builder --chown=1000:1000 /ms-playwright /ms-playwright


# Create non-root user (use existing group if GID 1000 exists, otherwise create new)
RUN if getent group 1000 > /dev/null 2>&1; then \
        EXISTING_GROUP=$(getent group 1000 | cut -d: -f1); \
        useradd -r -u 1000 -g $EXISTING_GROUP -m -d /home/botuser botuser || \
        useradd -r -g $EXISTING_GROUP -m -d /home/botuser botuser; \
    else \
        groupadd -r -g 1000 botuser && \
        useradd -r -u 1000 -g botuser -m -d /home/botuser botuser; \
    fi && \
    mkdir -p /home/botuser && chown -R botuser:$(getent group 1000 | cut -d: -f1) /home/botuser

USER botuser

# Only set essential Playwright environment variables
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_ENV=production

# Health check
# HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
#     CMD node healthcheck.js || exit 1

ENTRYPOINT ["node", "bot_entry_v2.js"]

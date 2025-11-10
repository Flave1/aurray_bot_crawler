# ── Stage 1: build environment ──
FROM node:18-slim AS builder

WORKDIR /app

# Install system dependencies for building
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget gnupg ca-certificates \
      build-essential \
      python3 \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Copy package files first (for better layer caching)
COPY package.json package-lock.json* ./

# Install dependencies (production only, clean npm cache)
RUN npm ci --only=production --no-audit --no-fund \
    && npm cache clean --force \
    && rm -rf /tmp/*

# Copy only necessary source files
COPY bot_entry.js healthcheck.js ./
COPY lib/ ./lib/
COPY platforms/ ./platforms/

# Install Playwright browsers (Chromium only to save space)
RUN npx playwright install chromium --with-deps \
    && mv /root/.cache/ms-playwright /ms-playwright \
    && rm -rf /root/.cache/playwright \
    && rm -rf /tmp/*

# Remove unnecessary files from node_modules
RUN find node_modules -name "*.map" -type f -delete \
    && find node_modules -name "*.ts" -type f -delete \
    && find node_modules -name "*.md" -type f -delete \
    && find node_modules -name "*.txt" -type f -delete \
    && find node_modules -name "test" -type d -exec rm -rf {} + 2>/dev/null || true \
    && find node_modules -name "tests" -type d -exec rm -rf {} + 2>/dev/null || true \
    && find node_modules -name "__tests__" -type d -exec rm -rf {} + 2>/dev/null || true \
    && find node_modules -name "examples" -type d -exec rm -rf {} + 2>/dev/null || true \
    && find node_modules -name ".github" -type d -exec rm -rf {} + 2>/dev/null || true \
    && find node_modules -name "docs" -type d -exec rm -rf {} + 2>/dev/null || true

# ── Stage 2: production image ──
FROM node:18-slim

WORKDIR /app

# Install only runtime dependencies (minimal set for Playwright)
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
      libatspi2.0-0 \
      libgtk-3-0 \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean \
    && rm -rf /tmp/*

# Copy only necessary files from builder
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/bot_entry.js /app/healthcheck.js /app/
COPY --from=builder /app/lib /app/lib
COPY --from=builder /app/platforms /app/platforms
COPY --from=builder /ms-playwright /ms-playwright

# Create non-root user (security best practice)
RUN groupadd -r botuser && useradd -r -g botuser -m botuser \
    && chown -R botuser:botuser /app /ms-playwright

# Switch to botuser
USER botuser

# Set runtime environment variables with defaults
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_ENV=production \
    MEETING_URL="" \
    BOT_NAME="Clerk AI Bot" \
    PLATFORM="google_meet" \
    MEETING_PASSCODE="" \
    RT_GATEWAY_URL="ws://44.203.236.62:8000" \
    API_BASE_URL="http://44.203.236.62:8000/" \
    MEETING_ID="" \
    SESSION_ID="" \
    JOIN_TIMEOUT_SEC=300 \
    NAVIGATION_TIMEOUT_MS=45000 \
    AUDIO_SAMPLE_RATE=16000 \
    AUDIO_CHANNELS=1 \
    ENABLE_AUDIO_CAPTURE="true" \
    ENABLE_TTS_PLAYBACK="true" \
    HEADLESS="true" \
    BROWSER_LOCALE="en-US" \
    BROWSER_ARGS="" \
    LOG_LEVEL="info" \
    TTS_PROVIDER="openai" \
    TTS_API_KEY="" \
    TTS_VOICE="alloy" \
    TTS_SPEED=1.0 \
    TTS_PITCH=1.0 \
    TTS_GAIN=0.7 \
    LLM_MOCK_URL="" \
    STORAGE_STATE=""

# Expose port for WebSocket / bot control
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node healthcheck.js || exit 1

# Start the bot entry script
ENTRYPOINT ["node", "bot_entry.js"]

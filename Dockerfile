# Loom Morph — single-process video render server for a multi-core VM.
#
# This runs the EXISTING app unchanged: Next.js UI + API, the in-process
# capture/render orchestrator, SQLite state, and local-disk video output. The
# only cloud-specific concerns are baked in here: real Google Chrome (recording
# mode needs H.264 to avoid frozen hero videos), ffmpeg, fonts, and the
# container Chrome flags (via LOOM_CONTAINER=1).
#
# Scale = cores. Set LOOM_CAPTURE_CONCURRENCY / LOOM_RENDER_CONCURRENCY to run
# more recordings/encodes in parallel (see DEPLOY.md).
#
# Debian (bookworm), not Alpine: Chrome needs glibc, and node-gyp builds of
# better-sqlite3 / sharp want a normal toolchain (included in the non-slim image).

FROM node:24-bookworm

# ── System deps: ffmpeg, fonts, and Google Chrome (stable) ──────────────────
# Chrome's apt package pulls in the shared libs headless Chromium needs, so we
# don't have to enumerate them. Fonts cover Latin + Noto (incl. CJK + emoji) so
# brand pages don't render tofu/boxes in the recording.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates wget gnupg ffmpeg \
      fonts-liberation fonts-noto fonts-noto-cjk fonts-noto-color-emoji \
  && wget -q -O /usr/share/keyrings/google-chrome.gpg.key https://dl.google.com/linux/linux_signing_key.pub \
  && gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg /usr/share/keyrings/google-chrome.gpg.key \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── App deps ────────────────────────────────────────────────────────────────
# Skip Playwright's bundled-browser download — we use system Chrome via
# `channel: 'chrome'`. better-sqlite3 / sharp compile against the image's Node.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json* ./
RUN npm ci

# ── App build ─────────────────────────────────────────────────────────────--
COPY . .
RUN npm run build

# ── Runtime config ──────────────────────────────────────────────────────────
ENV NODE_ENV=production
ENV LOOM_CONTAINER=1
# Tune these to the machine at `docker run` time (see DEPLOY.md). Conservative
# in-image defaults so a small box doesn't get oversubscribed by accident.
ENV LOOM_CAPTURE_CONCURRENCY=8
ENV LOOM_RENDER_CONCURRENCY=6
ENV PORT=3000
EXPOSE 3000

# SQLite DB + rendered videos live under these (relative to /app = cwd). Mount
# a volume here to persist batches across container restarts (see DEPLOY.md).
VOLUME ["/app/data", "/app/output"]

CMD ["npm", "run", "start"]

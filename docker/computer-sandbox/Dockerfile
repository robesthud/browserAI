# ──────────────────────────────────────────────────────────────────────────
# computer-sandbox — virtual desktop for BrowserAI's Computer Use tools.
#
# Architecture (matches Claude Computer Use reference design):
#   • Xvfb runs a virtual X11 display :99 (in-memory framebuffer)
#   • Openbox provides a minimal window manager so app windows render
#     with proper titlebars / focus / stacking
#   • scrot snapshots the framebuffer → PNG bytes the LLM "sees"
#   • xdotool emulates mouse + keyboard input on the display
#   • Firefox-ESR is the primary "real GUI" app (web pages, OAuth flows,
#     captchas, file uploads — anything browser_open can't handle).
#
# Communication with the API container is via `docker exec` (same channel
# as agent-sandbox). No network port is exposed.
#
# Resource caps live in docker-compose.yml (mem 400m, cpus 0.5).
# ──────────────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    SCREEN_WIDTH=1280 \
    SCREEN_HEIGHT=720 \
    SCREEN_DEPTH=24 \
    LANG=en_US.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      x11-utils \
      xdotool \
      scrot \
      imagemagick \
      openbox \
      firefox-esr \
      xterm \
      fonts-dejavu \
      fonts-noto-color-emoji \
      ca-certificates \
      curl \
      ttf-mscorefonts-installer \
      psmisc \
      procps \
  && rm -rf /var/lib/apt/lists/*

# Optional: a non-root user for apps that refuse to run as root (Firefox is
# fine as root in a container, but having :1000 lets us match agent-sandbox
# uid for files we may want to read from the workspace later).
RUN useradd -m -u 1000 -s /bin/bash computer || true

WORKDIR /home/computer

# Boot script: starts Xvfb + openbox in the background, then idles forever
# (the actual tool work happens via `docker exec`). xdpyinfo wait-loop
# ensures the display is genuinely up before we declare ready.
COPY entrypoint.sh /usr/local/bin/computer-entrypoint
RUN chmod +x /usr/local/bin/computer-entrypoint

# Drop screenshots into a tmpfs so we never write to the layer.
ENV SCREENSHOT_DIR=/tmp/screenshots
RUN mkdir -p /tmp/screenshots && chmod 0777 /tmp/screenshots

# Health: a fresh xdotool getactivewindow call after boot.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD pgrep -x Xvfb > /dev/null && DISPLAY=:99 xdpyinfo > /dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/computer-entrypoint"]

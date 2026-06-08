#!/bin/bash
# computer-sandbox boot:
#   1. Start Xvfb on :99 with the requested geometry.
#   2. Wait until xdpyinfo confirms the display is live (max 10s).
#   3. Start openbox (minimal WM) so windows have titlebars / focus.
#   4. Idle forever — actual tool work happens via `docker exec` from
#      the API container.
#
# Designed to never crash on app failure: each background process is
# wrapped so the main PID stays alive and docker-compose marks the
# container as healthy.
set -e

: "${DISPLAY:=:99}"
: "${SCREEN_WIDTH:=1280}"
: "${SCREEN_HEIGHT:=720}"
: "${SCREEN_DEPTH:=24}"

# 1. Xvfb
Xvfb "$DISPLAY" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}" \
     -ac -nolisten tcp -dpi 96 +extension RANDR >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!

# 2. Wait for display
for i in $(seq 1 50); do
  if DISPLAY="$DISPLAY" xdpyinfo >/dev/null 2>&1; then
    echo "[computer-sandbox] Xvfb ready on $DISPLAY (${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH})"
    break
  fi
  sleep 0.2
  if [ "$i" -eq 50 ]; then
    echo "[computer-sandbox] FATAL: Xvfb did not come up in 10s"
    cat /tmp/xvfb.log
    exit 1
  fi
done

# 3. Window manager (best-effort; agent can run without it)
DISPLAY="$DISPLAY" openbox >/tmp/openbox.log 2>&1 &
OPENBOX_PID=$!

# 4. Paint the root window a recognisable colour so a blank screenshot
#    obviously shows "nothing's running" rather than looking corrupt.
DISPLAY="$DISPLAY" xsetroot -solid '#1a1f2b' 2>/dev/null || true

echo "[computer-sandbox] Ready. Xvfb pid=$XVFB_PID openbox pid=$OPENBOX_PID"
echo "[computer-sandbox] Use docker exec to invoke xdotool / scrot / firefox."

# 5. Idle — keep PID 1 alive forever. exec tail so signals reach us cleanly.
exec tail -f /dev/null

#!/usr/bin/env bash
set -euo pipefail

# Applies BrowserAI's local patches to 00bx/gemini-web-proxy.
# Usage:
#   scripts/apply-gemini-web-proxy-patch.sh /opt/gemini-web-proxy

TARGET_DIR="${1:-/opt/gemini-web-proxy}"
# Resolve our own directory BEFORE any cd, so the snippet+patch paths stay
# absolute even after `cd "$TARGET_DIR"` below.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_FILE="$SCRIPT_DIR/gemini-web-proxy.patch"
POLL_SNIPPET="$SCRIPT_DIR/gemini-web-proxy-poll-media.py"

if [ ! -d "$TARGET_DIR" ]; then
  echo "Target directory not found: $TARGET_DIR" >&2
  exit 1
fi
if [ ! -f "$TARGET_DIR/server.py" ]; then
  echo "server.py not found in $TARGET_DIR" >&2
  exit 1
fi
if [ ! -f "$PATCH_FILE" ]; then
  echo "Patch file not found: $PATCH_FILE" >&2
  exit 1
fi

cd "$TARGET_DIR"
if git apply --check "$PATCH_FILE" 2>/dev/null; then
  git apply "$PATCH_FILE"
  echo "Applied Gemini Web Proxy patch to $TARGET_DIR"
else
  echo "Patch does not apply cleanly. It may already be applied or upstream changed." >&2
  if grep -q "extract_image_urls" server.py && grep -q "data:image/png;base64" server.py; then
    echo "Patch markers found; assuming already patched."
  else
    exit 2
  fi
fi

# ── Append poll-media endpoint snippet (idempotent) ─────────────────────────
# This is OUR module added directly on top of upstream, not a unified diff —
# we re-write it on every run so changes in BrowserAI's repo show up after
# `git pull && scripts/apply-gemini-web-proxy-patch.sh`.
if [ -f "$POLL_SNIPPET" ]; then
  cp "$TARGET_DIR/server.py" "$TARGET_DIR/server.py.bak.poll-media.$(date +%s)"
  # Strip any previously injected block (between the marker and EOF).
  sed -i '/# ── Injected by BrowserAI: poll-media endpoint ──/,$d' "$TARGET_DIR/server.py"
  # Append from the marker line onwards.
  sed -n '/# ── Injected by BrowserAI: poll-media endpoint ──/,$p' "$POLL_SNIPPET" >> "$TARGET_DIR/server.py"
  echo "Appended poll-media endpoint to $TARGET_DIR/server.py"
else
  echo "Note: poll-media snippet not found ($POLL_SNIPPET) — skipping." >&2
fi

# Sanity: byte-compile the result so a syntax error surfaces before restart.
if command -v "$TARGET_DIR/.venv/bin/python" >/dev/null 2>&1; then
  if ! "$TARGET_DIR/.venv/bin/python" -m py_compile "$TARGET_DIR/server.py"; then
    echo "ERROR: server.py failed to compile after patching." >&2
    exit 3
  fi
fi

echo
echo "Patch applied. Restart the service:"
echo "  systemctl restart gemini-web-proxy.service"

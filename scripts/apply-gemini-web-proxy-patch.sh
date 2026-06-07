#!/usr/bin/env bash
set -euo pipefail

# Applies BrowserAI's local patches to 00bx/gemini-web-proxy.
# Usage:
#   scripts/apply-gemini-web-proxy-patch.sh /opt/gemini-web-proxy

TARGET_DIR="${1:-/opt/gemini-web-proxy}"
PATCH_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gemini-web-proxy.patch"

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
    exit 0
  fi
  exit 2
fi

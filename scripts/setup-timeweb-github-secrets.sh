#!/usr/bin/env bash
set -euo pipefail

# Configure GitHub Actions secrets for BrowserAI Timeweb deploy.
#
# Requirements on your local/admin machine:
#   - gh CLI authenticated as repo owner/admin: gh auth login
#   - ssh access to the Timeweb server as DEPLOY_USER
#   - ssh-keygen
#
# Usage:
#   GITHUB_REPO=robesthud/browserAI \
#   TIMEWEB_HOST=186.246.31.78 \
#   TIMEWEB_USER=root \
#   TIMEWEB_APP_DIR=/opt/browserai \
#   ./scripts/setup-timeweb-github-secrets.sh
#
# The script:
#   1. Generates a dedicated ed25519 deploy key.
#   2. Installs the public key into ~/.ssh/authorized_keys on Timeweb.
#   3. Stores the private key and deploy parameters as GitHub Actions secrets.
#   4. Deletes the local private key after successful upload.

GITHUB_REPO="${GITHUB_REPO:-robesthud/browserAI}"
TIMEWEB_HOST="${TIMEWEB_HOST:-}"
TIMEWEB_USER="${TIMEWEB_USER:-root}"
TIMEWEB_APP_DIR="${TIMEWEB_APP_DIR:-/opt/browserai}"

if [[ -z "$TIMEWEB_HOST" ]]; then
  echo "ERROR: TIMEWEB_HOST is required" >&2
  exit 1
fi

command -v gh >/dev/null || { echo "ERROR: gh CLI is required" >&2; exit 1; }
command -v ssh-keygen >/dev/null || { echo "ERROR: ssh-keygen is required" >&2; exit 1; }
command -v ssh >/dev/null || { echo "ERROR: ssh is required" >&2; exit 1; }

TMPDIR="$(mktemp -d)"
KEY="$TMPDIR/browserai_timeweb_deploy_ed25519"
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

ssh-keygen -t ed25519 -N '' -C 'browserai-github-actions-deploy' -f "$KEY" >/dev/null
PUB="$(cat "$KEY.pub")"

echo "Installing deploy public key on ${TIMEWEB_USER}@${TIMEWEB_HOST}..."
ssh -o StrictHostKeyChecking=accept-new "${TIMEWEB_USER}@${TIMEWEB_HOST}" \
  "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qxF '$PUB' ~/.ssh/authorized_keys || echo '$PUB' >> ~/.ssh/authorized_keys"

echo "Verifying SSH key auth..."
ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "${TIMEWEB_USER}@${TIMEWEB_HOST}" 'echo ssh-key-ok'

echo "Writing GitHub Actions secrets to ${GITHUB_REPO}..."
gh secret set TIMEWEB_SSH_KEY  --repo "$GITHUB_REPO" < "$KEY"
printf '%s' "$TIMEWEB_HOST"    | gh secret set TIMEWEB_HOST    --repo "$GITHUB_REPO"
printf '%s' "$TIMEWEB_USER"    | gh secret set TIMEWEB_USER    --repo "$GITHUB_REPO"
printf '%s' "$TIMEWEB_APP_DIR" | gh secret set TIMEWEB_APP_DIR --repo "$GITHUB_REPO"

echo "Done. You can now run the Deploy to Timeweb workflow manually or push to main."

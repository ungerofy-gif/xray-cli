#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/usr/local/xray-cli"
API_SERVICE="xraycli-api"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "Repository not found at $REPO_DIR"
  exit 1
fi

cd "$REPO_DIR"

echo "[1/5] Pulling latest TypeScript source..."
git pull --ff-only

echo "[2/5] Installing Bun dependencies..."
if command -v bun >/dev/null 2>&1; then
  bun install --frozen-lockfile || bun install
elif [[ -x "$HOME/.bun/bin/bun" ]]; then
  "$HOME/.bun/bin/bun" install --frozen-lockfile || "$HOME/.bun/bin/bun" install
else
  echo "Bun not found in PATH or $HOME/.bun/bin/bun"
  exit 1
fi

echo "[3/5] Restarting ${API_SERVICE}..."
systemctl restart "$API_SERVICE"

echo "[4/5] Waiting for service health..."
for i in {1..15}; do
  if systemctl is-active --quiet "$API_SERVICE"; then
    break
  fi
  sleep 1
done

echo "[5/5] Service status"
systemctl status "$API_SERVICE" --no-pager -l

echo "Done. Bun/TypeScript service updated independently."

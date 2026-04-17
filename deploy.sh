#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/usr/local/xray-cli}"
GO_BIN="${GO_BIN:-/usr/local/go/bin/go}"
BUN_BIN="${BUN_BIN:-${HOME}/.bun/bin/bun}"

cd "$REPO_DIR"
git pull --ff-only

"$BUN_BIN" install --frozen-lockfile
"$BUN_BIN" x tsc --noEmit

cd "$REPO_DIR/go-bot"
"$GO_BIN" build -trimpath -ldflags='-s -w' -o bin/xray-telegram-bot ./cmd/bot

systemctl restart xraycli-api
systemctl restart xray-telegram-bot

systemctl --no-pager --full status xraycli-api xray-telegram-bot

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GO_BIN="${GO_BIN:-/usr/local/go/bin/go}"
BUN_BIN="${BUN_BIN:-${HOME}/.bun/bin/bun}"

cd "$ROOT_DIR"

echo "[1/3] Installing Bun dependencies"
"$BUN_BIN" install --frozen-lockfile

echo "[2/3] Type-checking TypeScript backend"
"$BUN_BIN" x tsc --noEmit

echo "[3/3] Building Go Telegram bot"
cd "$ROOT_DIR/go-bot"
"$GO_BIN" mod tidy
"$GO_BIN" build -trimpath -ldflags='-s -w' -o bin/xray-telegram-bot ./cmd/bot

echo "Build completed"

#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/root/xray-cli-ts"
BOT_DIR="$REPO_DIR/go-bot"

cd "$REPO_DIR"
git pull --ff-only

cd "$BOT_DIR"
make build

systemctl restart xray-telegram-bot
systemctl status xray-telegram-bot --no-pager

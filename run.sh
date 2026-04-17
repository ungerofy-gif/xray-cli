#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_BIN="${BUN_BIN:-${HOME}/.bun/bin/bun}"

cd "$ROOT_DIR"
exec "$BUN_BIN" run src/api/server.ts

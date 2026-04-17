# Xray Telegram Bot (Go)

Production-ready Telegram bot service for Xray CLI API.

## Architecture

- `cmd/bot/main.go`: process bootstrap, dependency wiring, graceful shutdown.
- `internal/config`: env loading, including `/etc/default/xraycli-api` fallback parsing.
- `internal/api`: HTTP API client for existing TypeScript API.
- `internal/service`: business logic (pagination, user details, edit/apply inbounds, create user flow).
- `internal/system`: runtime system metrics + Xray restart helper.
- `internal/state`: in-memory conversation/edit session state with TTL.
- `internal/telegram`: Telegram update handlers, callbacks, keyboards, flow orchestration.
- `internal/models`: API model structs.

## Features

- Inline keyboard UX.
- Russian UI text in Telegram messages and buttons.
- `/start` menu with:
  - `Состояние системы`
  - `Перезагрузка Xray`
  - `Пользователи`
- Live CPU/RAM/cores metrics via `gopsutil`.
- Xray restart via `systemctl restart xray` with diagnostics on failure.
- Users list with pagination.
- User detail view with status, traffic, expiry, subscription URLs.
- Toggle enable/disable, delete user, edit inbounds.
- Multi-step add-user conversation with validation.
- Telegram user whitelist (`TG_ALLOWED_USER_IDS`).

## Configuration

Bot reads env from process + optionally `/etc/default/xraycli-api` (or `SYSTEM_ENV_FILE`).

Required:
- `TG_BOT_TOKEN`
- `TG_ALLOWED_USER_IDS`

Reused from existing API env:
- `API_HOST`
- `API_PORT`
- `API_KEY`

Optional:
- `API_BASE_URL`
- `API_TIMEOUT` (default `10s`)
- `METRICS_TIMEOUT` (default `3s`)
- `COMMAND_TIMEOUT` (default `20s`)
- `USERS_PER_PAGE` (default `8`)

See `.env.example`.

## Build

```bash
cd /root/xray-cli-ts/go-bot
make tidy
make fmt
make build
```

Binary path:
- `/root/xray-cli-ts/go-bot/bin/xray-telegram-bot`

## systemd

Service file:
- `deploy/xray-telegram-bot.service`

Install:

```bash
cd /root/xray-cli-ts/go-bot
sudo make install-service
sudo systemctl restart xray-telegram-bot
sudo systemctl status xray-telegram-bot
```

## Safe Update Strategy (separate from Bun app)

1. Pull repo updates:

```bash
cd /root/xray-cli-ts
git pull --ff-only
```

2. Rebuild only Go bot:

```bash
cd /root/xray-cli-ts/go-bot
make build
```

3. Restart only Go bot service:

```bash
sudo systemctl restart xray-telegram-bot
```

4. Verify:

```bash
sudo systemctl status xray-telegram-bot
sudo journalctl -u xray-telegram-bot -n 100 --no-pager
```

This does not restart or modify Bun/TypeScript API service.

Automated helper:

```bash
sudo /root/xray-cli-ts/go-bot/deploy/update-go-bot.sh
```

## Recommended env files

`/etc/default/xraycli-api` (already used by TS API):

```dotenv
API_HOST=127.0.0.1
API_PORT=2053
API_KEY=replace-with-strong-key
```

`/etc/default/xraycli-telegram-bot`:

```dotenv
TG_BOT_TOKEN=123456789:YOUR_TOKEN
TG_ALLOWED_USER_IDS=111111111,222222222
API_TIMEOUT=10s
METRICS_TIMEOUT=3s
COMMAND_TIMEOUT=20s
USERS_PER_PAGE=8
```

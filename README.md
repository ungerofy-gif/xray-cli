# xray-cli-ts

TypeScript (Bun) backend + Go Telegram bot for Xray profile management.

## Ubuntu 24.04 setup

```bash
sudo bash /usr/local/xray-cli/install.sh
```

Or manual build:

```bash
cd /usr/local/xray-cli
./build.sh
```

## Run

```bash
# API (Bun)
./run.sh

# Go bot
cd go-bot && make build && ./bin/xray-telegram-bot
```

## Required env

`/etc/default/xraycli-api`:

```dotenv
API_HOST=127.0.0.1
API_PORT=2053
API_KEY=replace-me
XRAY_CONFIG_PATH=/usr/local/etc/xray/config.json
XRAY_API_ADDRESS=127.0.0.1:8080
XRAY_BIN_PATH=/usr/local/bin/xray
XRAYCLI_DATA_DIR=/var/lib/xray-cli
XRAY_STATS_SYNC_INTERVAL_MS=300000
XRAY_ANALYTICS_STEP_MS=900000
XRAY_ANALYTICS_RETENTION_DAYS=400
```

`/etc/default/xraycli-telegram-bot`:

```dotenv
TG_BOT_TOKEN=
TG_ALLOWED_USER_IDS=
API_TIMEOUT=8s
METRICS_TIMEOUT=2s
COMMAND_TIMEOUT=15s
USERS_PER_PAGE=8
SYSTEM_ENV_FILE=/etc/default/xraycli-api
```

## Services

- TS backend service: `deploy/xraycli-api.service`
- Go bot service: `go-bot/deploy/xray-telegram-bot.service`

## Safe updates

Update only TS backend:

```bash
sudo /usr/local/xray-cli/deploy/update-ts-service.sh
```

Update only Go bot:

```bash
sudo /usr/local/xray-cli/go-bot/deploy/update-go-bot.sh
```

Update both:

```bash
sudo /usr/local/xray-cli/deploy.sh
```

## Persistent analytics storage

- Source of truth for profiles + traffic analytics is backend DB file:
  - `/var/lib/xray-cli/xray-cli.json` (default via `XRAYCLI_DATA_DIR`)
- This path is outside repository/build directories, so `git pull`, rebuilds, binary replacement, and service restarts do not reset statistics.
- Backward compatibility:
  - On first start, backend auto-migrates legacy DB from `~/.config/xray-cli/xray-cli.json` if present.

# xray-cli-ts

Minimal TypeScript CLI/TUI and API server for managing Xray profiles and subscriptions.

## Install

```bash
bun install
```

## Usage

```bash
bun run start      # CLI/TUI
bun run api        # CLI API server (default 127.0.0.1:2053)
```

## Config Note

Generated Xray config keeps Xray core API only at top level:

```json
"api": {"tag":"api","listen":"127.0.0.1:8080","services":["StatsService"]}
```

Legacy API transport wiring (dokodemo-door API inbound/outbound routing) is removed.

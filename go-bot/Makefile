BINARY=bin/xray-telegram-bot
GO ?= $(shell command -v go 2>/dev/null || echo /usr/local/go/bin/go)
GOFMT ?= $(shell command -v gofmt 2>/dev/null || echo /usr/local/go/bin/gofmt)

.PHONY: build run test fmt tidy install-service

build:
	mkdir -p bin
	$(GO) build -trimpath -ldflags='-s -w' -o $(BINARY) ./cmd/bot

run:
	$(GO) run ./cmd/bot

test:
	$(GO) test ./...

fmt:
	$(GOFMT) -w ./cmd ./internal

tidy:
	$(GO) mod tidy

install-service:
	install -m 0644 deploy/xray-telegram-bot.service /etc/systemd/system/xray-telegram-bot.service
	systemctl daemon-reload
	systemctl enable xray-telegram-bot

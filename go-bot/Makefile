BINARY=bin/xray-telegram-bot

.PHONY: build run test fmt tidy install-service

build:
	mkdir -p bin
	go build -trimpath -ldflags='-s -w' -o $(BINARY) ./cmd/bot

run:
	go run ./cmd/bot

test:
	go test ./...

fmt:
	gofmt -w ./cmd ./internal

tidy:
	go mod tidy

install-service:
	install -m 0644 deploy/xray-telegram-bot.service /etc/systemd/system/xray-telegram-bot.service
	systemctl daemon-reload
	systemctl enable xray-telegram-bot

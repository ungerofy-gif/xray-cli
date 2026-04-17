package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/example/xray-cli-ts/go-bot/internal/api"
	"github.com/example/xray-cli-ts/go-bot/internal/config"
	"github.com/example/xray-cli-ts/go-bot/internal/service"
	"github.com/example/xray-cli-ts/go-bot/internal/state"
	"github.com/example/xray-cli-ts/go-bot/internal/telegram"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg, err := config.Load()
	if err != nil {
		logger.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	apiClient := api.New(cfg.APIBaseURL, cfg.APIKey, cfg.RequestTimeout)
	svc := service.New(apiClient)
	store := state.NewStore(20 * time.Minute)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	tg, err := telegram.New(ctx, cfg, svc, store, logger)
	if err != nil {
		logger.Error("failed to init telegram bot", "error", err)
		os.Exit(1)
	}

	logger.Info("telegram bot started")
	tg.Start(ctx)
	logger.Info("telegram bot stopped")
}

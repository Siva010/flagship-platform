// Command dataplane serves ruleset snapshots and holds the SSE fan-out.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/flagship/data-plane/internal/api"
	"github.com/flagship/data-plane/internal/hub"
	"github.com/flagship/data-plane/internal/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	addr := envOrDefault("ADDR", ":8080")
	shards := envInt("HUB_SHARDS", 32)
	bufferSize := envInt("HUB_BUFFER_SIZE", 16)
	historySize := envInt("HISTORY_SIZE", store.DefaultHistorySize)

	broadcastHub := hub.New(hub.Options{Shards: shards, BufferSize: bufferSize})
	snapshotStore := store.New(broadcastHub, historySize)

	server := api.NewServer(api.Options{
		Hub:    broadcastHub,
		Store:  snapshotStore,
		Logger: logger,
	})

	srv := &http.Server{
		Addr:              addr,
		Handler:           server.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
		// No WriteTimeout: SSE connections are long-lived, and a write deadline
		// would sever every stream on a fixed schedule.
		IdleTimeout: 120 * time.Second,
	}

	go func() {
		logger.Info("data plane listening",
			"addr", addr, "shards", shards, "bufferSize", bufferSize, "historySize", historySize)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("listen failed", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	logger.Info("shutting down", "connected", broadcastHub.Stats().Connected)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Disconnect streams first. Otherwise Shutdown waits out every long-lived
	// SSE connection and the drain deadline expires for no reason.
	broadcastHub.CloseAll()

	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("shutdown failed", "err", err)
	}
}

func envOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

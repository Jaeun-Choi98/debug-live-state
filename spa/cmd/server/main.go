package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"pjt/internal/config"
	"pjt/internal/logger"
	"pjt/internal/server"
	"syscall"
	"time"
)

func main() {
	cfg, err := config.NewConfiguration()
	if err != nil {
		logger.Errorln(err)
		os.Exit(1)
	}

	level, levelErr := logger.ParseLevel(cfg.LogLevel)
	l, err := logger.NewCustomLogger("", level)
	if err != nil {
		logger.Errorln(err)
		os.Exit(1)
	}
	logger.SetLogger(l)
	if levelErr != nil {
		logger.Warnf("[Main] %v, fallback to %s", levelErr, level)
	}
	logger.StartCleaning()
	defer logger.Shutdown()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	srv := server.New(cfg)
	errCh := make(chan error, 1)
	go func() { errCh <- srv.Start() }()
	logger.Infof("[Main] server listening on %s:%s", cfg.RestIp, cfg.RestPort)

	select {
	case <-ctx.Done():
		logger.Infoln("[Main] shutting down...")
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Errorf("[Main] server error: %v", err)
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Errorf("[Main] shutdown error: %v", err)
	}
	logger.Infoln("[Main] application terminated")
}

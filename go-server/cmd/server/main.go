package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"pjt/internal/app"
	"pjt/internal/config"
	"pjt/internal/container"
	"syscall"
	"time"

	"github.com/Jaeun-Choi98/modules/logger"
)

const restartDelay = 3 * time.Second

func main() {

	cfg, err := config.NewConfiguration()
	if err != nil {
		log.Printf("[Main] failed to create new configuration, err: %v", err)
		os.Exit(1)
	}

	level, levelErr := logger.ParseLevel(cfg.LogLevel)
	// 패키지 기본 로거로 등록 ( log/YYYY/MM/D/app.log, 오늘 + 지난 1일 보존 )
	if _, err := logger.Init(logger.Options{
		Dir:        logger.DefaultDir,
		Level:      level,
		MaxAgeDays: 1,
		Console:    os.Stderr,
	}); err != nil {
		log.Printf("[Main] failed to init logger, err: %v", err)
		os.Exit(1)
	}

	if levelErr != nil {
		logger.Warnf("[Main] %v, fallback to %s", levelErr, level)
	}
	logger.Infof("[Main] log level: %s", level)

	var code int
	switch cfg.DeployMode {
	case config.TEST:
		code = Test(cfg)
	case config.PRODUCT:
		code = Product(cfg)
	default:
		logger.Errorf("[Main] undefined deploy stage, deploy mode: %v", cfg.DeployMode)
		code = 1
	}

	if err := logger.Close(); err != nil {
		log.Printf("[Main] failed to close logger: %v", err)
	}

	os.Exit(code)
}

func run(cfg *config.Configuration) (cause error) {
	container.NewContainer(cfg)
	defer container.DiscardContainer()

	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)

	a := app.NewApplication(cancel)
	a.Start()
	<-ctx.Done()

	return context.Cause(ctx)
}

func Product(cfg *config.Configuration) int {
	for {
		cause := run(cfg)

		if errors.Is(cause, app.ErrSignal) {
			logger.Infof("[Main] main process terminated by user (%v)", cause)
			return 0
		}

		logger.Warnf("[Main] main process terminated abnormally (%v). restarting in %v.", cause, restartDelay)
		if !waitRestart(restartDelay) {
			logger.Infof("[Main] received signal while waiting to restart. exit.")
			return 0
		}
	}
}

func Test(cfg *config.Configuration) int {
	cause := run(cfg)

	if errors.Is(cause, app.ErrSignal) {
		logger.Infof("[Main] main process terminated by user (%v)", cause)
		return 0
	}
	logger.Errorf("[Main] main process terminated abnormally (%v)", cause)
	return 1
}

func waitRestart(d time.Duration) bool {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	select {
	case <-time.After(d):
		return true
	case <-ctx.Done():
		return false
	}
}

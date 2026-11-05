package main

import (
	"context"
	"os"
	"pjt/internal/app"
	"pjt/internal/config"
	"pjt/internal/container"

	"time"

	"github.com/Jaeun-Choi98/modules/logger"
)

func main() {
	logger.Init(logger.Options{
		Level:      logger.INFO,
		MaxAgeDays: 1,
		Console:    os.Stderr,
	})

	logger.Infoln("[Main] hello world!")

	cfg, err := config.NewConfiguration()
	if err != nil {
		logger.Errorln(err)
		os.Exit(1)
	}
	ProductMode(cfg)
}

func TestMode(cfg *config.Configuration) {
	mainCtx, mainCancel := context.WithCancel(context.Background())
	defer mainCancel()

	container.NewContainer(cfg)

	myApp := app.NewApplication(mainCancel)
	if err := myApp.Start(); err != nil {
		logger.Errorf("[Main] failed to start app, err: %v", err.Error())
		return
	}

	<-mainCtx.Done()

	container.DiscardContainer()
}

func ProductMode(cfg *config.Configuration) {
	for {
		TestMode(cfg)
		logger.Warnln("[Main] try recovering app goroutine...")
		time.Sleep(3 * time.Second)
	}
}

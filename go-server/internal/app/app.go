package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"pjt/internal/container"
	"runtime/debug"
	"sync"
	"syscall"
	"time"

	"github.com/Jaeun-Choi98/modules/logger"
)

type Application struct {
	mainCtxCancel context.CancelFunc
	wg            sync.WaitGroup
}

func NewApplication(cancel context.CancelFunc) *Application {
	n := &Application{
		mainCtxCancel: cancel,
	}
	return n
}

func (a *Application) safeGo(name string, fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				logger.Errorf("[App][%s] panic: %v\n%s", name, r, debug.Stack())
				a.mainCtxCancel()
			}
		}()

		fn()
	}()
}

func (a *Application) Start() error {

	logger.Infof("[App] Application goroutine start")

	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, syscall.SIGHUP, syscall.SIGINT, syscall.SIGKILL, syscall.SIGTERM)

	go func() {
		defer close(signalCh)
		defer signal.Stop(signalCh)
		sig := <-signalCh
		switch sig {
		case syscall.SIGHUP:
			logger.Infof("[App] closed session(siganl: %+v)", syscall.SIGHUP)
		case syscall.SIGINT:
			logger.Infof("[App] user use ctrl+c(siganl: %+v)", syscall.SIGINT)
		case syscall.SIGKILL:
			logger.Infof("[App] received force exit(siganl: %+v)", syscall.SIGKILL)
		case syscall.SIGTERM:
			logger.Infof("[App] received exit(siganl: %+v)", syscall.SIGTERM)
		}
		logger.Infoln("[App] shuting down...")
		if err := a.Shutdown(); err != nil {
			logger.Errorf("[App] issued error in shutting down: \n%+v", err.Error())
		}
	}()

	a.wg.Add(1)
	var errs []error
	a.safeGo("http", func() {
		defer a.wg.Done()
		if err := container.GetRestServer().Start(); err != nil {
			logger.Errorf("[App] failed to start http rest server, err: %v", err)
			errs = append(errs, fmt.Errorf("[App] failed to start http rest server, err: %v", err))
		}
	})

	return errors.Join(errs...)
}

func (a *Application) Shutdown() error {
	var errs []error
	ctx, timeout := context.WithTimeout(context.Background(), 5*time.Second)
	defer timeout()
	if err := container.GetRestServer().Shutdown(ctx); err != nil {
		errs = append(errs, err)
	}
	a.wg.Wait()
	logger.Infof("[App] app goroutine is terminated")
	a.mainCtxCancel()
	return errors.Join(errs...)
}

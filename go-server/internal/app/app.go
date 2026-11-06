package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"pjt/internal/container"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/Jaeun-Choi98/modules/logger"
)

var (
	ErrSignal = errors.New("terminated by signal")
	ErrPanic  = errors.New("terminated by panic")
)

// server 는 앱이 관리하는 서버가 구현해야 하는 생명주기.
type server interface {
	// Listen 은 포트를 바인딩한다. 바인딩 실패를 Serve 전에 동기적으로 알려준다.
	Listen() error
	// Serve 는 Shutdown 될 때까지 블록된다. 정상 종료 시 http.ErrServerClosed 를 돌려준다.
	Serve() error
	Shutdown(ctx context.Context) error
}

type namedServer struct {
	name string
	server
}

type Application struct {
	wg            sync.WaitGroup
	mainCtxCancel context.CancelCauseFunc
	servers       []namedServer

	stopOnce  sync.Once
	signalErr atomic.Pointer[error]
	done      chan struct{}
}

func NewApplication(cancel context.CancelCauseFunc) *Application {
	return &Application{
		mainCtxCancel: cancel,
		done:          make(chan struct{}),
	}
}

func (a *Application) safeGo(name string, fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				logger.Errorf("[App][%s] panic: %v\n%s", name, r, debug.Stack())
				a.stop(fmt.Errorf("%w: [%s] %v", ErrPanic, name, r))
			}
		}()
		fn()
	}()
}

func (a *Application) Start() {

	a.servers = []namedServer{
		{"http", container.GetRestServer()},
	}

	var errs []error
	for _, s := range a.servers {
		if err := s.Listen(); err != nil {
			errs = append(errs, fmt.Errorf("[%s] failed to listen, err: %w", s.name, err))
		}
	}
	if err := errors.Join(errs...); err != nil {
		a.stop(err)
		return
	}

	// 시그널 고루틴은 shutdown 에서 servers 와 리스너를 읽으므로, 둘을 다 채운 뒤에 띄운다.
	a.handleSignal()

	for _, s := range a.servers {
		a.wg.Add(1)
		a.safeGo(s.name, func() {
			// stop 은 shutdown 에서 wg.Wait 을 하므로 wg.Done 을 먼저 해야 한다. ( panic 시에도 Done 되도록 defer )
			err := func() error {
				defer a.wg.Done()
				return s.Serve()
			}()
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				logger.Errorf("[App] %s server stopped unexpectedly, err: %v", s.name, err)
				a.stop(fmt.Errorf("[%s] server stopped unexpectedly, err: %w", s.name, err))
			}
		})
	}
}

func (a *Application) handleSignal() {
	signalChan := make(chan os.Signal, 1)
	signal.Notify(signalChan, syscall.SIGHUP, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		defer signal.Stop(signalChan)

		select {
		case sig := <-signalChan:
			switch sig {
			case syscall.SIGHUP:
				logger.Infof("[App] closed session(signal: %v)", sig)
			case syscall.SIGINT:
				logger.Infof("[App] user use ctrl+c(signal: %v)", sig)
			case syscall.SIGTERM:
				logger.Infof("[App] received exit(signal: %v)", sig)
			}
			a.stop(fmt.Errorf("%w: %v", ErrSignal, sig))
		case <-a.done:
		}
	}()
}

func (a *Application) stop(cause error) {
	if errors.Is(cause, ErrSignal) {
		a.signalErr.CompareAndSwap(nil, &cause)
	}

	a.stopOnce.Do(func() {
		logger.Infof("[App] Shutting down... (cause: %v)", cause)
		a.shutdown()

		if sigErr := a.signalErr.Load(); sigErr != nil {
			cause = *sigErr
		}
		close(a.done)
		a.mainCtxCancel(cause)
	})
}

func (a *Application) shutdown() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, s := range a.servers {
		if err := s.Shutdown(ctx); err != nil {
			logger.Infof("[App] Error during %s shutdown: %v", s.name, err)
		}
	}

	a.wg.Wait()
	logger.Infoln("[App] Application terminated")
}

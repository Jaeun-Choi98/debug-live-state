package rest

import (
	"context"
	"net"
	"net/http"
	"pjt/internal/config"

	"pjt/internal/transport/middleware"
	"time"

	"github.com/Jaeun-Choi98/modules/logger"
	"github.com/gin-gonic/gin"
)

type RestServer struct {
	server   *http.Server
	listener net.Listener
	useTLS   bool
	cert     string
	key      string
}

func New(cfg *config.Configuration) *RestServer {
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery(), middleware.LogMiddleware(), middleware.NewCORSMiddleware(cfg.Cors, true))

	// API 는 /api 아래에 등록한다. 매칭되지 않은 경로는 NoRoute 의 SPA 핸들러가 처리한다.
	api := router.Group("/api")
	api.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// 로그 레벨 조회 및 실행 중 변경 ( 재기동 시 env.ini 값으로 복귀 )
	// ex) curl 'host/log-config?level=debug'
	router.GET("/log-config", handleLogConfig)

	router.NoRoute(middleware.SpaHandler("/api", cfg.SpaDir, cfg.SpaIndex))

	return &RestServer{
		server: &http.Server{
			Addr:        cfg.RestIp + ":" + cfg.RestPort,
			Handler:     router,
			ReadTimeout: 5 * time.Second,
		},
		useTLS: cfg.TLS == 1,
		cert:   cfg.SSLCERT,
		key:    cfg.SSLKEY,
	}
}

// handleLogConfig 는 현재 로그 레벨을 돌려준다. 쿼리를 주면 레벨을 바꾼 뒤 돌려준다.
//
//	GET /log-config                조회
//	GET /log-config?level=debug    레벨 변경 (debug/info/warn/error)
func handleLogConfig(c *gin.Context) {
	if levelStr, ok := c.GetQuery("level"); ok {
		level, err := logger.ParseLevel(levelStr)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		logger.SetLevel(level)
		logger.Warnf("[REST] log level changed: %s, remote: %s", level, c.ClientIP())
	}
	c.JSON(http.StatusOK, gin.H{"level": logger.GetLevel().String()})
}

// Listen 은 포트를 바인딩한다. 포트 사용 중 같은 바인딩 실패를 Serve 전에 동기적으로 알 수 있다.
func (s *RestServer) Listen() error {
	ln, err := net.Listen("tcp", s.server.Addr)
	if err != nil {
		return err
	}
	s.listener = ln
	return nil
}

// Serve 는 Listen 으로 바인딩한 포트에서 요청을 처리하며 Shutdown 될 때까지 블록된다.
// Shutdown 으로 정상 종료되면 http.ErrServerClosed 를 돌려준다.
func (s *RestServer) Serve() error {
	logger.Infof("[REST] http rest server goroutine start")

	if s.useTLS {
		return s.server.ServeTLS(s.listener, s.cert, s.key)
	}
	return s.server.Serve(s.listener)
}

func (s *RestServer) Shutdown(ctx context.Context) error {
	err := s.server.Shutdown(ctx)
	// Serve 에 들어가기 전에 종료된 경우 http.Server 가 리스너를 모르므로 직접 닫는다. ( 이미 닫힌 경우의 에러는 무시 )
	if s.listener != nil {
		_ = s.listener.Close()
	}
	logger.Infoln("[REST] http rest server goroutine is terminated")
	return err
}

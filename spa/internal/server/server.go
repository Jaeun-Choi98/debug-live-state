package server

import (
	"context"
	"net/http"
	"pjt/internal/config"
	"pjt/internal/logger"
	"pjt/internal/server/middleware"
	"time"

	"github.com/gin-gonic/gin"
)

type Server struct {
	server *http.Server
	useTLS bool
	cert   string
	key    string
}

func New(cfg *config.Configuration) *Server {
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

	return &Server{
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

func (s *Server) Start() error {
	if s.useTLS {
		return s.server.ListenAndServeTLS(s.cert, s.key)
	}
	return s.server.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
	err := s.server.Shutdown(ctx)
	logger.Infoln("[REST] server terminated")
	return err
}

package rest

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"pjt/internal/config"
	"pjt/internal/processes"
	"strconv"

	"pjt/internal/transport/middleware"
	"time"

	"github.com/Jaeun-Choi98/modules/logger"
	"github.com/gin-gonic/gin"
)

type RestServer struct {
	server   *http.Server
	listener net.Listener
	monitor  *processes.Monitor
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

	// 그룹 · 서버 · 프로세스 설정, SSH 로 확인한 프로세스 상태 · 로그, 프로세스 제어
	store := processes.NewStore(cfg.ProcessesFile)
	monitor := processes.NewMonitor(store, cfg.KnownHostsFile)
	// 자동 재시작을 켠 프로세스를 감시한다. ( 서버 종료 시 Shutdown 에서 멈춘다 )
	monitor.StartWatchdog()
	api.GET("/config", handleGetConfig(store))
	api.PUT("/config", requireJSON, handlePutConfig(store, monitor))
	api.GET("/status", handleStatus(monitor))
	api.GET("/processes/:id/files", handleFiles(monitor))
	api.GET("/processes/:id/log", handleLog(monitor))
	api.POST("/processes/:id/:action", requireJSON, handleControl(monitor))

	router.NoRoute(middleware.SpaHandler("/api", cfg.SpaDir, cfg.SpaIndex))

	return &RestServer{
		server: &http.Server{
			Addr:        cfg.RestIp + ":" + cfg.RestPort,
			Handler:     router,
			ReadTimeout: 5 * time.Second,
		},
		monitor: monitor,
		useTLS:  cfg.TLS == 1,
		cert:    cfg.SSLCERT,
		key:     cfg.SSLKEY,
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

// 설정 저장 요청 본문 최대 크기
const maxConfigBodyBytes = 1 << 20

// requireJSON 은 상태를 바꾸는 요청(PUT · POST)에 Content-Type: application/json 을 요구한다.
// 다른 사이트의 <form> 은 이 헤더로 요청을 보낼 수 없으므로, 다른 사이트를 통해 몰래 프로세스를 중지시키는 요청(CSRF)을 막는다.
func requireJSON(c *gin.Context) {
	if c.ContentType() != "application/json" {
		c.AbortWithStatusJSON(http.StatusUnsupportedMediaType, gin.H{"error": "Content-Type: application/json 이 필요합니다"})
		return
	}
	c.Next()
}

// respondError 는 화면에 보여줄 오류(UserError)는 그 상태 코드로, SSH 실패 등은 502 로 응답한다.
func respondError(c *gin.Context, err error) {
	var userErr *processes.UserError
	if errors.As(err, &userErr) {
		c.JSON(userErr.Status, gin.H{"error": userErr.Message})
		return
	}
	c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
}

// GET /api/config: 설정 조회 ( 비밀번호 대신 hasPassword )
func handleGetConfig(store *processes.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		config, err := store.Load()
		if err != nil {
			logger.Errorf("[REST] failed to load processes config, err: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "설정 파일을 읽지 못했습니다"})
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, processes.Public(config))
	}
}

// PUT /api/config: 설정 전체 교체
func handlePutConfig(store *processes.Store, monitor *processes.Monitor) gin.HandlerFunc {
	return func(c *gin.Context) {
		body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, maxConfigBodyBytes))
		if err != nil {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "요청 본문이 너무 큽니다"})
			return
		}

		config, err := store.Save(body)
		switch {
		case errors.Is(err, processes.ErrInvalid):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		case err != nil:
			logger.Errorf("[REST] failed to save processes config, err: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "설정 파일을 저장하지 못했습니다"})
			return
		}

		monitor.Reset()
		logger.Warnf("[REST] processes config saved, remote: %s", c.ClientIP())
		c.JSON(http.StatusOK, processes.Public(config))
	}
}

// GET /api/status?group=uw : 그룹(all 이면 전체)의 서버별 프로세스 상태
func handleStatus(monitor *processes.Monitor) gin.HandlerFunc {
	return func(c *gin.Context) {
		servers, err := monitor.GroupStatus(c.Request.Context(), c.DefaultQuery("group", "all"))
		if err != nil {
			respondError(c, err)
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{"servers": servers})
	}
}

// GET /api/processes/:id/files?path=2026-11 : 로그 폴더 아래 폴더의 파일 · 폴더 목록 ( path 를 비우면 로그 폴더 )
func handleFiles(monitor *processes.Monitor) gin.HandlerFunc {
	return func(c *gin.Context) {
		list, err := monitor.Files(c.Request.Context(), c.Param("id"), c.Query("path"))
		if err != nil {
			respondError(c, err)
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, list)
	}
}

// GET /api/processes/:id/log?path=app.log&lines=200 : 로그 폴더 아래 파일의 끝부분
func handleLog(monitor *processes.Monitor) gin.HandlerFunc {
	return func(c *gin.Context) {
		lines, _ := strconv.Atoi(c.DefaultQuery("lines", "200"))
		output, err := monitor.Log(c.Request.Context(), c.Param("id"), c.Query("path"), lines)
		if err != nil {
			respondError(c, err)
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{"output": output})
	}
}

// POST /api/processes/:id/start|stop|restart : 프로세스 제어 ( 누가 했는지 로그에 남긴다 )
func handleControl(monitor *processes.Monitor) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, action := c.Param("id"), c.Param("action")
		logger.Warnf("[REST] process %s requested: %s, remote: %s", action, id, c.ClientIP())

		message, err := monitor.Control(c.Request.Context(), id, action)
		if err != nil {
			logger.Warnf("[REST] process %s failed: %s, err: %v", action, id, err)
			respondError(c, err)
			return
		}
		logger.Infof("[REST] process %s done: %s (%s)", action, id, message)
		c.JSON(http.StatusOK, gin.H{"message": message})
	}
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
	s.monitor.Close()
	// Serve 에 들어가기 전에 종료된 경우 http.Server 가 리스너를 모르므로 직접 닫는다. ( 이미 닫힌 경우의 에러는 무시 )
	if s.listener != nil {
		_ = s.listener.Close()
	}
	logger.Infoln("[REST] http rest server goroutine is terminated")
	return err
}

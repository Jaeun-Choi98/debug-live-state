package middleware

import (
	"fmt"
	"pjt/internal/logger"
	"time"

	"github.com/gin-gonic/gin"
)

func LogMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		t := time.Now()

		c.Next()

		logText := fmt.Sprintf(
			"[%s] %s \"%s %s %s\" %d %.3fsec \"%s\"",
			time.Now().Format(time.RFC1123),
			c.ClientIP(),
			c.Request.Method,
			c.Request.URL.Path,
			c.Request.Proto,
			c.Writer.Status(),
			time.Since(t).Seconds(),
			c.Request.UserAgent(),
		)
		logger.Infoln(logText)
	}
}

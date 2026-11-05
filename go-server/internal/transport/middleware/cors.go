package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func NewCORSMiddleware(allowedOrigins []string, allowCredentials bool) gin.HandlerFunc {
	const allowHeaders = "Content-Type,Authorization,Token,Cache-Control,Accept,Last-Event-ID,X-Requested-With,X-CSRF-Token"

	return func(c *gin.Context) {
		origin := c.Request.Header.Get("Origin")

		// 오리진별로 응답이 달라짐을 캐시에 알림 (필수)
		/**
		 * 오리진에 따라 응답 헤더가 달라지는데 Vary가 없으면 CDN이나 중간 캐시가 A 오리진용 응답을 B 오리진에 그대로 내줍니다. HTTPS + CDN 환경에서 실제로 재현되는 문제
		 */
		c.Writer.Header().Add("Vary", "Origin")
		c.Writer.Header().Add("Vary", "Access-Control-Request-Method")
		c.Writer.Header().Add("Vary", "Access-Control-Request-Headers")

		if origin == "" {
			c.Next()
			return
		}

		wildcard, matched := false, false
		for _, o := range allowedOrigins {
			if o == "*" {
				wildcard = true
			} else if o == origin {
				matched = true
				break
			}
		}

		switch {
		case matched:
			c.Header("Access-Control-Allow-Origin", origin)
			if allowCredentials {
				c.Header("Access-Control-Allow-Credentials", "true")
			}
		case wildcard:
			// '*'와 credentials는 브라우저가 함께 허용하지 않음
			c.Header("Access-Control-Allow-Origin", "*")
		default:
			// 허용되지 않은 오리진: CORS 헤더를 붙이지 않고 preflight만 종료
			if c.Request.Method == http.MethodOptions {
				c.AbortWithStatus(http.StatusNoContent)
				return
			}
			c.Next()
			return
		}

		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS")
		c.Header("Access-Control-Allow-Headers", allowHeaders)
		c.Header("Access-Control-Expose-Headers", "Content-Length, Content-Disposition")
		c.Header("Access-Control-Max-Age", "600")

		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

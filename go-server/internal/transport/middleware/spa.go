package middleware

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// 정적 파일로 노출하지 않을 확장자
var blockedExt = map[string]bool{
	".git": true,
	".ini": true,
	".map": true,
}

// blockedExt 에 걸리더라도 서빙을 허용하는 경로 prefix
// ( 프론트가 런타임에 fetch 하는 설정 파일: build/config/endpoints.ini )
var allowedPrefixes = []string{
	"/config/",
}

func isBlocked(urlPath, ext string) bool {
	if !blockedExt[ext] {
		return false
	}
	for _, prefix := range allowedPrefixes {
		if strings.HasPrefix(urlPath, prefix) {
			return false
		}
	}
	return true
}

// SpaHandler 는 staticDir 의 빌드 결과물을 서빙한다.
//   - 파일이 있으면 그대로 서빙
//   - 확장자 없는 경로(/about, /users/1 ...)는 클라이언트 라우팅으로 보고 indexFile 로 fallback
//   - 확장자 있는 경로인데 파일이 없거나 apiPrefix 로 시작하면 404
func SpaHandler(apiPrefix, staticDir, indexFile string) gin.HandlerFunc {
	fileServer := http.FileServer(http.Dir(staticDir))
	indexPath := filepath.Join(staticDir, indexFile)

	return func(c *gin.Context) {
		if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
			c.AbortWithStatus(http.StatusNotFound)
			return
		}

		// path.Clean 은 항상 "/" 로 시작하는 경로에서 ".." 를 제거하므로 staticDir 밖으로 나갈 수 없다.
		urlPath := path.Clean("/" + c.Request.URL.Path)
		if urlPath == apiPrefix || strings.HasPrefix(urlPath, apiPrefix+"/") {
			c.AbortWithStatus(http.StatusNotFound)
			return
		}

		ext := path.Ext(urlPath)
		if isBlocked(urlPath, ext) {
			c.AbortWithStatus(http.StatusNotFound)
			return
		}

		info, err := os.Stat(filepath.Join(staticDir, filepath.FromSlash(urlPath)))
		switch {
		case err == nil && !info.IsDir():
			fileServer.ServeHTTP(c.Writer, c.Request)
		case err == nil || errors.Is(err, fs.ErrNotExist):
			if ext != "" {
				c.AbortWithStatus(http.StatusNotFound)
				return
			}
			// index.html 은 배포마다 바뀌므로 캐시하지 않는다.
			c.Header("Cache-Control", "no-cache")
			c.File(indexPath)
		default:
			c.AbortWithStatus(http.StatusInternalServerError)
		}
	}
}

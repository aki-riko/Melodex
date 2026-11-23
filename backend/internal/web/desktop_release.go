package web

import (
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// desktopReleasePrefix 是桌面客户端发布产物的 URL 前缀。
//
// 路径约定（见 docs/desktop-release-updater.md）：
//
//	https://<站点>/desktop/latest.json          ← 更新清单
//	https://<站点>/desktop/<安装包文件名>         ← 安装包本体
//
// 为什么不复用 SPA 静态目录：那套逻辑未命中时会回退 index.html，
// 更新器收到 HTML 会报 “error decoding response body”，
// 而且页面上一切正常，排查成本极高。
const desktopReleasePrefix = "/desktop/"

// desktopReleaseDirEnv 指向宿主上的发布产物目录（可选）。
//
// 为什么要外部目录而不是 embed：安装包 3.5MB 起，每次发版都重建镜像不划算，
// 也不该把二进制塞进 git。设了就用它，没设才退回嵌入目录（占位为空）。
//
// 部署侧约定：compose 里挂一个只读卷，并设
//
//	MELODEX_DESKTOP_RELEASE_DIR=/home/appuser/data/desktop-release
const desktopReleaseDirEnv = "MELODEX_DESKTOP_RELEASE_DIR"

// registerDesktopRelease 在 /desktop/ 下托管桌面客户端发布产物。
//
// 行为：
//   - 命中真实文件 → 原样返回（安装包按 octet-stream 让下载器处理）；
//   - 未命中 → 404，**绝不回退 HTML**。
//
// 发布目录为空（还没发过版）时所有请求都是 404，这是正确行为：
// 此时壳侧只会记一条 WARN，不影响应用使用。
func registerDesktopRelease(r *gin.Engine) {
	sub := resolveDesktopReleaseFS()
	if sub == nil {
		return
	}

	r.GET(desktopReleasePrefix+"*filepath", func(c *gin.Context) {
		requested := strings.TrimPrefix(c.Param("filepath"), "/")
		// path.Clean 之后再取，避免 ../ 穿越到发布目录之外。
		// fs.FS 本身也不接受含 ".." 的路径（Open 会报错），这里是双保险。
		clean := path.Clean(requested)
		if clean == "." || clean == "" || strings.HasPrefix(clean, "..") {
			c.Status(http.StatusNotFound)
			return
		}

		file, err := sub.Open(clean)
		if err != nil {
			c.Status(http.StatusNotFound)
			return
		}
		defer file.Close()

		info, err := file.Stat()
		if err != nil || info.IsDir() {
			c.Status(http.StatusNotFound)
			return
		}

		contentType := "application/octet-stream"
		if strings.HasSuffix(clean, ".json") {
			contentType = "application/json; charset=utf-8"
			// 更新清单不能被缓存太久：否则发了新版用户还在读旧清单。
			c.Header("Cache-Control", "no-cache")
		}
		c.Header("Content-Type", contentType)

		// 用 http.ServeContent 而不是 c.FileFromFS：
		// 前者支持 Range 请求（安装包体积不小，下载器常带 Range）。
		seekable, ok := file.(interface {
			Read([]byte) (int, error)
			Seek(int64, int) (int64, error)
		})
		if !ok {
			c.Status(http.StatusInternalServerError)
			return
		}
		http.ServeContent(c.Writer, c.Request, info.Name(), info.ModTime(), seekable)
	})
}

// resolveDesktopReleaseFS 决定发布产物从哪里读。
//
// 优先级：环境变量指向的宿主目录 → 嵌入目录。
// 环境变量目录不存在时退回嵌入目录（而不是整个禁用路由）：
// 让"还没来得及放产物"表现为 404，而不是让路由消失。
func resolveDesktopReleaseFS() fs.FS {
	if dir := strings.TrimSpace(os.Getenv(desktopReleaseDirEnv)); dir != "" {
		abs, err := filepath.Abs(dir)
		if err == nil {
			if info, statErr := os.Stat(abs); statErr == nil && info.IsDir() {
				return os.DirFS(abs)
			}
			log.Printf("[desktop-release] 发布目录不存在，退回嵌入目录 dir=%q", abs)
		}
	}
	sub, err := fs.Sub(desktopReleaseFS, "desktop_release")
	if err != nil {
		return nil
	}
	return sub
}

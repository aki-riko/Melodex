package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/gin-gonic/gin"
)

// frontendDistFS 嵌入 React 前端构建产物(frontend/build/*)。
// 占位目录含一个 index.html;Docker 构建时会把真正的产物拷进 frontend_dist/ 再编译。
//
//go:embed all:frontend_dist
var frontendDistFS embed.FS

// desktopReleaseFS 嵌入桌面客户端发布产物(latest.json 与安装包)。
//
// 为什么要单独 embed 而不是塞进 frontend_dist：
//
//	① 它不属于前端路由，混进去会被 SPA fallback 逻辑一并处理；
//	② 桌面更新器不携带 SSO 会话，也不该被当成页面。
//
// 目录默认只有 .gitkeep，真正产物在发版时放入（见 docs/desktop-release-updater.md）。
// 目录为空时 /desktop/ 下的请求返回 404，而不是回退成 HTML 首页——
// 后者会让更新器报 “error decoding response body”，且极难定位。
//
//go:embed all:desktop_release
var desktopReleaseFS embed.FS

// registerFrontend 在根路径托管 React 单页应用(SPA)。
// 静态资源按真实路径返回;未命中的路径回退到 index.html(交给前端路由)。
// API 路径(/api、/music)由各自的路由处理,不会进到这里。
func registerFrontend(r *gin.Engine) {
	sub, err := fs.Sub(frontendDistFS, "frontend_dist")
	if err != nil {
		return
	}
	fileServer := http.FileServer(http.FS(sub))

	// 直接读出 index.html 内容返回,避免 FileServer 对 "/" 触发 "./" 目录重定向(死循环)。
	indexHTML, _ := fs.ReadFile(sub, "index.html")

	// ★ 静态资源中间件：gzip 压缩 + Cache-Control。
	// 实测线上主 JS 包 228KB 裸传、且无缓存头（每次重新下载），
	// 加 gzip 后首屏可省约 70%（520KB → 159KB）。详见 static_assets.go 的注释。
	//
	// 只应用到**静态资源出口**，不影响 /api 与 /music 的 JSON/音频流：
	// 音频已压缩且需要 Range 请求（gzip 会破坏 Range 语义），绝不能压。
	assetMiddleware := staticAssetMiddleware()

	serveIndex := func(c *gin.Context) {
		c.Data(http.StatusOK, "text/html; charset=utf-8", indexHTML)
	}

	// 桌面客户端发布产物（/desktop/latest.json 与安装包）。
	//
	// 必须**先于** SPA fallback 注册：更新器拿到的必须是静态文件或 404，
	// 绝不能是 index.html。历史上没这个路由时请求会回退成 HTML，
	// 表现是壳日志里一条
	//   [WARN] update check failed: 检查更新失败：error decoding response body
	// 而页面本身完全正常，非常难猜。
	registerDesktopRelease(r)

	// 根路径返回 SPA 入口。
	// ★ 也要走资源中间件：HTML 同样需要 Vary + no-cache（否则发版后
	//   用户浏览器缓存住旧 index.html，永远拿不到新 bundle 的哈希）。
	r.GET("/", assetMiddleware, serveIndex)

	// NoRoute:静态资源直出,其余回退 index.html(SPA 前端路由)。
	// 已注册的 /api/*、/music/* 命中各自路由,不会落到 NoRoute。
	r.NoRoute(assetMiddleware, func(c *gin.Context) {
		p := c.Request.URL.Path
		// API/后端路径未命中时不应返回前端页面,保持 404 语义。
		if strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, RoutePrefix+"/") {
			c.Status(http.StatusNotFound)
			return
		}
		// /desktop/ 属于发布产物目录：内部已处理，走到这里说明已被兜底，
		// 同样返回 404，绝不回退成 HTML（否则更新器解析失败）。
		if strings.HasPrefix(p, desktopReleasePrefix) {
			c.Status(http.StatusNotFound)
			return
		}
		// 探测静态文件是否存在(去掉前导斜杠)
		clean := strings.TrimPrefix(path.Clean(p), "/")
		if clean != "" && clean != "." {
			if f, err := sub.Open(clean); err == nil {
				f.Close()
				fileServer.ServeHTTP(c.Writer, c.Request)
				return
			}
		}
		// 其余路径回退到 SPA 入口
		serveIndex(c)
	})
}

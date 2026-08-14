package web

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/gin-gonic/gin"
)

const RoutePrefix = "/music"

var (
	legacyMusicPageRoutes = []string{
		"/", "/recommend", "/user_playlists", "/playlist_categories",
		"/category_playlists", "/search", "/playlist", "/album", "/album_jump",
	}
	legacyCollectionPageRoutes = []string{"/my_collections", "/collection"}
	legacyLocalMusicPageRoutes = []string{"/local_music_page"}
	legacyStandalonePageRoutes = []string{"/render"}
)

func isLegacyWebPagePath(requestPath string) bool {
	requestPath = strings.TrimSuffix(requestPath, "/")
	if requestPath == RoutePrefix {
		return true
	}
	for _, routes := range [][]string{
		legacyMusicPageRoutes,
		legacyCollectionPageRoutes,
		legacyLocalMusicPageRoutes,
		legacyStandalonePageRoutes,
	} {
		for _, route := range routes {
			if requestPath == RoutePrefix+strings.TrimSuffix(route, "/") {
				return true
			}
		}
	}
	return false
}

func defaultSourcesForSearchType(searchType string) []string {
	switch searchType {
	case "playlist":
		return core.GetPlaylistSourceNames()
	case "album":
		return core.GetAlbumSourceNames()
	case "lyric":
		return core.GetLyricSearchSourceNames()
	default:
		return core.GetDefaultSourceNames()
	}
}

// corsAllowedOrigins 来自 env MUSIC_DL_CORS_ORIGINS(逗号分隔的完整 Origin,如
// https://music.9li.life,http://localhost:3000)。生产前端与后端同源,通常无需配置。
func corsAllowedOrigins() map[string]bool {
	set := map[string]bool{}
	for _, o := range strings.Split(os.Getenv("MUSIC_DL_CORS_ORIGINS"), ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			set[strings.ToLower(o)] = true
		}
	}
	return set
}

func corsMiddleware() gin.HandlerFunc {
	allowed := corsAllowedOrigins()
	return func(c *gin.Context) {
		method := c.Request.Method
		origin := c.GetHeader("Origin")
		// 只对「同源」或「显式白名单」的来源回显 Allow-Origin + 允许携带凭据,
		// 不再反射任意 Origin(否则等于授权任意站点带 cookie 跨站读取)。
		if origin != "" {
			parsed, err := url.Parse(origin)
			sameOrigin := err == nil && strings.EqualFold(parsed.Host, c.Request.Host)
			if sameOrigin || allowed[strings.ToLower(origin)] {
				c.Header("Access-Control-Allow-Origin", origin)
				c.Header("Vary", "Origin")
				c.Header("Access-Control-Allow-Credentials", "true")
			}
			// 非同源且非白名单:不设任何 Allow-Origin → 浏览器拦截跨站读取。
		}
		c.Header("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE, UPDATE")
		c.Header("Access-Control-Allow-Headers", "Origin, X-Requested-With, X-Melodex-Expected-User-ID, Content-Type, Accept, Authorization")
		c.Header("Access-Control-Expose-Headers", "Content-Length, Cache-Control, Content-Language, Content-Type, X-Melodex-Playback-Source, X-Melodex-Chunk-Index, X-Melodex-Chunk-Duration, X-Melodex-Chunk-Final")
		if method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
		}
		c.Next()
	}
}

// securityHeadersMiddleware 注入基础安全响应头(纵深防御:防 MIME 嗅探/点击劫持/Referer 泄露)。
// 不设过严的 CSP 以免破坏内联样式/外链封面;仅加广泛兼容的几项。
func securityHeadersMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.Writer.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Referrer-Policy", "no-referrer")
		c.Next()
	}
}

func setDownloadHeader(c *gin.Context, filename string) {
	filename = strings.ReplaceAll(strings.TrimSpace(filename), "\\", "/")
	if slash := strings.LastIndex(filename, "/"); slash >= 0 {
		filename = strings.TrimSpace(filename[slash+1:])
	}
	if filename == "" {
		filename = "download"
	}
	encoded := url.PathEscape(filename)
	fallback := asciiDownloadFilenameFallback(filename)
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"; filename*=UTF-8''%s", fallback, encoded))
}

func asciiDownloadFilenameFallback(filename string) string {
	filename = strings.TrimSpace(filename)
	if filename == "" {
		return "download"
	}

	base := filename
	ext := ""
	if dot := strings.LastIndex(filename, "."); dot > 0 && dot < len(filename)-1 {
		candidateExt := filename[dot:]
		if candidateExt == asciiDownloadFilenamePart(candidateExt) {
			base = filename[:dot]
			ext = candidateExt
		}
	}

	fallback := strings.Trim(asciiDownloadFilenamePart(base), " .-_")
	if fallback == "" {
		fallback = "download"
	}
	return fallback + ext
}

func asciiDownloadFilenamePart(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '.', r == '-', r == '_', r == ' ':
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}

func legacyWebPageGone(c *gin.Context) {
	c.String(http.StatusGone, "该网页界面已下线,请使用 Melodex 前端。")
}

type StartOptions struct {
	ShouldOpenBrowser bool
	DisableAuth       bool
	ListenHost        string
}

func Start(port string, shouldOpenBrowser bool) {
	StartWithOptions(port, StartOptions{ShouldOpenBrowser: shouldOpenBrowser})
}

func StartDesktop(port string) {
	StartWithOptions(port, StartOptions{
		DisableAuth: true,
		ListenHost:  "127.0.0.1",
	})
}

func StartWithOptions(port string, opts StartOptions) {
	core.CM.Load()
	InitDB()
	defer CloseDB()
	startBackgroundCacheMaintenance()

	if !opts.DisableAuth {
		n, err := countUsers()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to read account config: %v\n", err)
		} else if token, tokenErr := prepareSetupToken(n > 0); tokenErr == nil && token != "" {
			fmt.Printf("Web setup token: %s\nOpen %s/setup and keep this startup terminal private until setup is complete.\n", token, RoutePrefix)
		}
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.LoggerWithFormatter(redactedGinLogFormatter), gin.Recovery())
	// 可信代理:env MUSIC_DL_TRUSTED_PROXIES(逗号分隔 CIDR/IP)配置后,仅这些来源的
	// X-Forwarded-For 被 ClientIP() 采信,防客户端伪造 XFF 绕过限流/登录锁。
	// 未配置时显式不信任任何代理头;有反代部署时请配置真实反代网段。
	if tp := strings.TrimSpace(os.Getenv("MUSIC_DL_TRUSTED_PROXIES")); tp != "" {
		var proxies []string
		for _, p := range strings.Split(tp, ",") {
			if p = strings.TrimSpace(p); p != "" {
				proxies = append(proxies, p)
			}
		}
		if err := r.SetTrustedProxies(proxies); err != nil {
			fmt.Fprintf(os.Stderr, "SetTrustedProxies failed: %v\n", err)
		}
	} else if err := r.SetTrustedProxies(nil); err != nil {
		fmt.Fprintf(os.Stderr, "SetTrustedProxies failed: %v\n", err)
	}
	r.Use(corsMiddleware())
	r.Use(securityHeadersMiddleware())

	api := r.Group(RoutePrefix)

	api.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"app":    "melodex",
			"status": "ok",
		})
	})

	configAPI, userAPI := bindAuthMiddleware(api, opts)

	// optionalUserAPI:公开读路由,但若已登录则注入用户(GET /settings 据此返回个人偏好)。
	optionalUserAPI := api.Group("")
	if !opts.DisableAuth {
		optionalUserAPI.Use(attachUserOptional())
	} else {
		optionalUserAPI.Use(desktopUserMiddleware())
	}

	for _, route := range legacyStandalonePageRoutes {
		api.GET(route, legacyWebPageGone)
	}

	configAPI.HEAD("/cookies", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	configAPI.GET("/cookies", func(c *gin.Context) { c.JSON(200, core.CM.GetAll()) })
	configAPI.POST("/cookies", func(c *gin.Context) {
		var req map[string]string
		if err := c.ShouldBindJSON(&req); err == nil {
			core.CM.SetAll(req)
			core.CM.Save()
			c.JSON(200, gin.H{"status": "ok"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid cookies payload"})
	})

	// GET /settings:返回合并视图(系统级全局设置 + 当前用户展示偏好)。
	// 公开读(未登录返回全局默认),登录后浮动歌词/每页条数为用户自己的偏好。
	optionalUserAPI.GET("/settings", func(c *gin.Context) {
		c.JSON(200, effectiveSettingsForUser(currentUserID(c)))
	})
	// POST /settings:系统级设置写入,仅管理员(configAPI)。
	// 注意:展示偏好(浮动歌词/每页条数)请走 /user/prefs,按用户隔离。
	configAPI.POST("/settings", func(c *gin.Context) {
		var req core.WebSettings
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid settings payload"})
			return
		}
		if err := core.SaveWebSettings(req); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, effectiveSettingsForUser(currentUserID(c)))
	})
	// 用户展示偏好(浮动歌词/每页条数),仅登录即可,按 user_id 隔离。
	userAPI.POST("/user/prefs", func(c *gin.Context) {
		uid := currentUserID(c)
		if uid == 0 {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
			return
		}
		var req UserPref
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid prefs payload"})
			return
		}
		if err := saveUserPref(uid, req); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, effectiveSettingsForUser(uid))
	})

	// 旧 /music JSON/播放/下载接口默认要求登录;桌面模式仍注入本地用户免登录。
	musicAPI := api.Group("")
	if !opts.DisableAuth {
		musicAPI.Use(authRequired())
	}
	RegisterMusicRoutes(musicAPI)
	RegisterQRLoginRoutes(configAPI)
	// 歌单/收藏/本地库按 user_id 隔离 → 必须登录(userAPI)。
	RegisterCollectionRoutes(userAPI)
	RegisterLocalMusicRoutes(userAPI)
	RegisterSearchHistoryRoutes(userAPI)
	RegisterPlayHistoryRoutes(userAPI)
	RegisterPlaybackDiagnosticRoutes(userAPI)
	RegisterFavoriteRoutes(userAPI)
	RegisterUpdateRoutes(userAPI)

	// 供 React 前端使用的纯 JSON 接口(/api/v1),复用 /music 下的下载与媒体接口。
	// 敏感接口(登录/cookie)复用同一套管理员鉴权。
	RegisterJSONAPIRoutes(r, opts)
	RegisterDesktopLyricsRoutes(r, opts)

	// Melodex 新增:Subsonic API facade(/rest),让音流等标准 Subsonic 客户端直接连。
	// 默认关闭,须配 env(MUSIC_DL_SUBSONIC_ENABLED + USER + PASS)才启用;自带 Subsonic 认证。
	RegisterSubsonicRoutes(r)

	// Melodex:在根路径托管 React 前端 SPA(产物嵌入二进制)。必须最后注册(含 NoRoute 兜底)。
	registerFrontend(r)

	listenAddr := opts.ListenHost + ":" + port
	listener, err := net.Listen("tcp", listenAddr)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "address already in use") {
			fmt.Fprintf(os.Stderr, "Failed to start web server: port %s is already in use. Please use --port to specify another port, e.g. music-dl web --port 8081\n", port)
			return
		}
		fmt.Fprintf(os.Stderr, "Failed to start web server on %s: %v\n", listenAddr, err)
		return
	}

	urlStr := localWebAppURL(opts.ListenHost, port)
	fmt.Printf("Web started at %s\n", urlStr)
	if opts.ShouldOpenBrowser {
		go func() { time.Sleep(500 * time.Millisecond); core.OpenBrowser(urlStr) }()
	}
	server := &http.Server{
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      serverWriteTimeout,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
		// WriteTimeout 覆盖普通接口防 Slow Read;音频流式接口(music.go / subsonic_stream.go)
		// 在写响应前调用 clearWriteDeadline 解除本限制(流时长不可预期)。
	}
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintf(os.Stderr, "Web server stopped with error: %v\n", err)
	}
}

func localWebAppURL(listenHost, port string) string {
	urlHost := strings.TrimSpace(listenHost)
	if urlHost == "" || urlHost == "0.0.0.0" || urlHost == "::" {
		urlHost = "localhost"
	}
	return (&url.URL{
		Scheme: "http",
		Host:   net.JoinHostPort(urlHost, port),
		Path:   "/",
	}).String()
}

// bindAuthMiddleware 装配鉴权并返回两个分组:
//   - adminAPI:登录 + 管理员(cookie/系统设置/QR 登录/用户管理)。
//   - userAPI:仅需登录(歌单/收藏/下载/本地库,按 user_id 隔离)。
//
// 桌面/本机模式(DisableAuth):注入本地管理员用户免登录,两个分组都等于注入了用户的 api。
func bindAuthMiddleware(api *gin.RouterGroup, opts StartOptions) (adminAPI, userAPI *gin.RouterGroup) {
	bindAuthRoutes(api)
	if opts.DisableAuth {
		api.Use(desktopUserMiddleware())
		return api, api
	}
	adminAPI = api.Group("")
	adminAPI.Use(authRequired(), adminRequired())
	userAPI = api.Group("")
	userAPI.Use(authRequired())
	return adminAPI, userAPI
}

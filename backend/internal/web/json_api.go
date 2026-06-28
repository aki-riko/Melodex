package web

import (
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/guohuiyuan/go-music-dl/core"
	"github.com/guohuiyuan/music-lib/model"
)

// RegisterJSONAPIRoutes 注册供 React 前端使用的纯 JSON 接口,挂在 /api/v1 下。
// 与原有 /music/* 的 HTMX(HTML 片段)路由并存,互不影响。
//
// 安全模型:只读接口(搜索/歌单/专辑/歌词/推荐)公开,与原版一致;
// 改写状态的敏感接口(扫码登录写 cookie、清除 cookie)挂到管理员鉴权之后,
// 与原版 configAPI 同一套鉴权(opts.DisableAuth 时放行,用于本机桌面模式)。
func RegisterJSONAPIRoutes(r *gin.Engine, opts StartOptions) {
	api := r.Group("/api/v1")

	// 公开读接口(搜索等)挂非阻塞用户注入:登录用户的搜索可记入个人历史,
	// 匿名用户照常可用。桌面模式注入本地用户。
	if opts.DisableAuth {
		api.Use(desktopUserMiddleware())
	} else {
		api.Use(attachUserOptional())
	}

	api.GET("/healthz", func(c *gin.Context) {
		c.JSON(200, gin.H{"app": "melodex", "status": "ok"})
	})

	// 可用音乐源列表(前端 source 选择用)
	api.GET("/sources", func(c *gin.Context) {
		c.JSON(200, gin.H{
			"all":      core.GetAllSourceNames(),
			"default":  core.GetDefaultSourceNames(),
			"playlist": core.GetPlaylistSourceNames(),
			"album":    core.GetAlbumSourceNames(),
		})
	})

	// 搜索会放大到所有上游音源,加 per-IP 限流(30 次/分钟)防滥用。
	api.GET("/search", rateLimitMiddleware(searchRateLimiter), jsonSearchHandler)

	// 歌单详情:返回歌曲列表
	api.GET("/playlist", func(c *gin.Context) {
		id := c.Query("id")
		src := c.Query("source")
		if id == "" || src == "" {
			c.JSON(400, gin.H{"error": "缺少参数 id/source"})
			return
		}
		fn := core.GetPlaylistDetailFunc(src)
		if fn == nil {
			c.JSON(400, gin.H{"error": "该源不支持查看歌单详情"})
			return
		}
		songs, err := fn(id)
		if songs == nil {
			songs = []model.Song{}
		}
		out := gin.H{"songs": songs, "type": "playlist", "source": src, "link": core.GetOriginalLink(src, id, "playlist")}
		if err != nil {
			out["error"] = fmt.Sprintf("获取歌单失败: %v", err)
		}
		c.JSON(200, out)
	})

	// 专辑详情:返回歌曲列表
	api.GET("/album", func(c *gin.Context) {
		id := c.Query("id")
		src := c.Query("source")
		if id == "" || src == "" {
			c.JSON(400, gin.H{"error": "缺少参数 id/source"})
			return
		}
		fn := core.GetAlbumDetailFunc(src)
		if fn == nil {
			c.JSON(400, gin.H{"error": "该源不支持查看专辑详情"})
			return
		}
		songs, err := fn(id)
		if songs == nil {
			songs = []model.Song{}
		}
		out := gin.H{"songs": songs, "type": "album", "source": src, "link": core.GetOriginalLink(src, id, "album")}
		if err != nil {
			out["error"] = fmt.Sprintf("获取专辑失败: %v", err)
		}
		c.JSON(200, out)
	})

	// 每日推荐歌单:按源返回歌单列表
	api.GET("/recommend", func(c *gin.Context) {
		sources := filterAvailableSources(c.QueryArray("sources"), core.GetRecommendSourceNames())
		c.JSON(200, gin.H{"tabs": loadPlaylistTabsJSON(sources, func(src string) ([]model.Playlist, error) {
			fn := core.GetRecommendFunc(src)
			if fn == nil {
				return nil, fmt.Errorf("该源不支持推荐歌单")
			}
			return fn()
		})})
	})

	// 歌单分类列表
	api.GET("/playlist_categories", func(c *gin.Context) {
		sources := filterAvailableSources(c.QueryArray("sources"), core.GetPlaylistCategorySourceNames())
		result := []gin.H{}
		for _, src := range sources {
			fn := core.GetPlaylistCategoriesFunc(src)
			if fn == nil {
				continue
			}
			cats, err := fn()
			entry := gin.H{"source": src, "source_name": core.GetSourceDescription(src), "categories": cats}
			if err != nil {
				entry["error"] = err.Error()
			}
			result = append(result, entry)
		}
		c.JSON(200, gin.H{"sources": result})
	})

	// 某分类下的歌单
	api.GET("/category_playlists", func(c *gin.Context) {
		source := strings.TrimSpace(c.Query("source"))
		categoryID := strings.TrimSpace(c.Query("category_id"))
		fn := core.GetCategoryPlaylistsFunc(source)
		if source == "" || fn == nil {
			c.JSON(400, gin.H{"error": "该源不支持歌单分类"})
			return
		}
		playlists, err := fn(categoryID, 1, 120)
		for i := range playlists {
			playlists[i].Source = source
		}
		if playlists == nil {
			playlists = []model.Playlist{}
		}
		out := gin.H{"playlists": playlists, "source": source}
		if err != nil {
			out["error"] = fmt.Sprintf("获取分类歌单失败: %v", err)
		}
		c.JSON(200, out)
	})

	// 支持二维码登录的源(只读,公开)
	api.GET("/qr_login/sources", func(c *gin.Context) {
		c.JSON(200, gin.H{"sources": core.GetQRLoginSourceNames()})
	})

	// 账号鉴权接口(登录/登出/注册/初始化/当前用户)。见 auth_api.go。
	registerAuthAPIRoutes(api, opts)

	// Cookie 与二维码登录管理是管理员独占(平台会员 cookie 全局共享,见隔离决策)。
	// DisableAuth(桌面/本机模式)时注入本地管理员用户放行。
	adminSecure := api.Group("")
	if opts.DisableAuth {
		adminSecure.Use(desktopUserMiddleware())
	} else {
		adminSecure.Use(authRequired(), adminRequired())
	}
	registerLoginAndCookieRoutes(adminSecure)

	// 用户管理(增删用户/改角色/重置密码/开放注册开关)同为管理员独占。
	registerAdminUserRoutes(adminSecure)
}

// registerLoginAndCookieRoutes 注册二维码登录与 Cookie 管理。
// 这些接口会改写登录态或读取登录状态,必须在鉴权之后(由调用方决定是否套 authRequired)。
func registerLoginAndCookieRoutes(api *gin.RouterGroup) {

	// 创建二维码登录会话
	api.POST("/qr_login/:source", func(c *gin.Context) {
		source := strings.TrimSpace(c.Param("source"))
		fn := core.GetQRLoginCreateFunc(source)
		if fn == nil {
			c.JSON(404, gin.H{"error": "该源不支持二维码登录"})
			return
		}
		session, err := fn()
		if err != nil {
			c.JSON(502, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, session)
	})

	// 轮询二维码登录状态;成功则保存 cookie
	api.GET("/qr_login/:source", func(c *gin.Context) {
		source := strings.TrimSpace(c.Param("source"))
		key := strings.TrimSpace(c.Query("key"))
		if key == "" {
			c.JSON(400, gin.H{"error": "缺少 key"})
			return
		}
		fn := core.GetQRLoginCheckFunc(source)
		if fn == nil {
			c.JSON(404, gin.H{"error": "该源不支持二维码登录"})
			return
		}
		result, err := fn(key)
		if err != nil {
			c.JSON(502, gin.H{"error": err.Error()})
			return
		}
		if result != nil && result.Status == model.QRLoginStatusSuccess {
			cookie := qrLoginCookieString(result)
			if cookie != "" {
				cookieSource := qrLoginCookieSource(source)
				result.Cookie = cookie
				core.CM.SetAll(map[string]string{cookieSource: cookie})
				core.CM.Save()
			}
		}
		c.JSON(200, result)
	})

	// 读取已保存的 cookie(仅返回各源是否已登录,不回显 cookie 明文)
	api.GET("/cookies", func(c *gin.Context) {
		all := core.CM.GetAll()
		status := map[string]bool{}
		for src, v := range all {
			status[src] = strings.TrimSpace(v) != ""
		}
		c.JSON(200, gin.H{"logged_in": status})
	})

	// 清除某源 cookie(退出登录)。SetAll 对空值执行删除(见 core.CookieManager.SetAll)。
	api.DELETE("/cookies/:source", func(c *gin.Context) {
		source := strings.TrimSpace(c.Param("source"))
		core.CM.SetAll(map[string]string{source: ""})
		core.CM.Save()
		c.JSON(200, gin.H{"status": "ok"})
	})

	// 手动填入某源 cookie(扫码拿不到完整鉴权字段时,如 QQ 音乐的 qm_keyst,
	// 可从对应平台网页版登录后抠出完整 cookie 粘贴)。
	api.POST("/cookies/:source", func(c *gin.Context) {
		source := strings.TrimSpace(c.Param("source"))
		var req struct {
			Cookie string `json:"cookie"`
		}
		if c.ShouldBindJSON(&req) != nil || strings.TrimSpace(req.Cookie) == "" {
			c.JSON(400, gin.H{"error": "cookie 不能为空"})
			return
		}
		core.CM.SetAll(map[string]string{source: strings.TrimSpace(req.Cookie)})
		core.CM.Save()
		c.JSON(200, gin.H{"status": "ok"})
	})
}

// jsonSearchSongResult 在 model.Song 基础上附带前端友好的展示字段。
type jsonSearchResponse struct {
	Songs     []model.Song     `json:"songs"`
	Playlists []model.Playlist `json:"playlists"`
	Type      string           `json:"type"`
	Keyword   string           `json:"keyword"`
	Sources   []string         `json:"sources"`
	Error     string           `json:"error,omitempty"`
}

// jsonSearchHandler 复用 core 的并发多源搜索逻辑,返回结构化 JSON
// (对应原 music.go 的 /music/search,但用 c.JSON 替代 renderIndex 的 HTML 片段)。
func jsonSearchHandler(c *gin.Context) {
	keyword := strings.TrimSpace(c.Query("q"))
	searchType := c.DefaultQuery("type", "song")
	exactArtist := strings.TrimSpace(c.Query("exact_artist"))
	sources := c.QueryArray("sources")

	if len(sources) == 0 {
		sources = defaultSourcesForSearchType(searchType)
	}

	resp := jsonSearchResponse{
		Songs:     []model.Song{},
		Playlists: []model.Playlist{},
		Type:      searchType,
		Keyword:   keyword,
		Sources:   sources,
	}

	if keyword == "" {
		resp.Error = "搜索关键词不能为空"
		c.JSON(400, resp)
		return
	}

	// 链接解析模式(粘贴歌曲/歌单/专辑链接)
	if strings.HasPrefix(keyword, "http") {
		songs, playlists, finalType, errMsg := parseLinkSearch(keyword, searchType)
		resp.Songs = songs
		resp.Playlists = playlists
		resp.Type = finalType
		resp.Error = errMsg
		if errMsg != "" {
			c.JSON(200, resp)
			return
		}
	} else {
		// 关键词搜索:先查结果缓存(含完整元数据),命中直接返回。
		cacheKey := searchCacheKey(searchType, keyword, exactArtist, sources)
		if cached, ok := getCachedSearch(cacheKey); ok {
			recordSearchHistory(currentUserID(c), keyword, cached.Type)
			c.JSON(200, cached)
			return
		}

		// 关键词多源并发搜索
		songs, playlists := concurrentKeywordSearch(keyword, searchType, sources)
		resp.Songs = songs
		resp.Playlists = playlists

		// 综合排序(与 Subsonic search3 一致):相关性 + 上游名次 + 原唱信号 − 翻唱降权。
		if resp.Type == "song" && keyword != "" && len(resp.Songs) > 0 {
			sortSongsByRelevance(resp.Songs, keyword)
		}
		if resp.Type == "song" && exactArtist != "" && len(resp.Songs) > 0 {
			resp.Songs = filterSongsByExactArtist(resp.Songs, exactArtist)
		}

		// 写缓存(排序/过滤后的最终结果)+ 记搜索历史。
		putCachedSearch(cacheKey, resp)
		recordSearchHistory(currentUserID(c), keyword, resp.Type)
		c.JSON(200, resp)
		return
	}

	c.JSON(200, resp)
}

// concurrentKeywordSearch 多源并发搜索(从 music.go 搜索闭包提炼,去掉 HTML 渲染)。
func concurrentKeywordSearch(keyword, searchType string, sources []string) ([]model.Song, []model.Playlist) {
	allSongs := []model.Song{}
	allPlaylists := []model.Playlist{}
	var wg sync.WaitGroup
	var mu sync.Mutex

	for _, src := range sources {
		wg.Add(1)
		go func(s string) {
			defer wg.Done()
			switch searchType {
			case "playlist":
				if fn := core.GetPlaylistSearchFunc(s); fn != nil {
					if res, err := fn(keyword); err == nil {
						for i := range res {
							res[i].Source = s
						}
						mu.Lock()
						allPlaylists = append(allPlaylists, res...)
						mu.Unlock()
					}
				}
			case "album":
				if fn := core.GetAlbumSearchFunc(s); fn != nil {
					if res, err := fn(keyword); err == nil {
						for i := range res {
							res[i].Source = s
						}
						mu.Lock()
						allPlaylists = append(allPlaylists, res...)
						mu.Unlock()
					}
				}
			default:
				if fn := core.GetSearchFunc(s); fn != nil {
					if res, err := fn(keyword); err == nil {
						for i := range res {
							res[i].Source = s
							// 记录该结果在本源内的原始排名(上游相关性信号)。
							// 译名/别名搜索时上游知道相关性而本地字符串匹配不到,
							// 排序回退到此名次,避免被判 0 分沉底。
							if res[i].Extra == nil {
								res[i].Extra = map[string]string{}
							}
							res[i].Extra["_rank"] = strconv.Itoa(i)
						}
						mu.Lock()
						allSongs = append(allSongs, res...)
						mu.Unlock()
					}
				}
			}
		}(src)
	}
	wg.Wait()
	return allSongs, allPlaylists
}

// parseLinkSearch 解析粘贴的链接(歌曲/歌单/专辑),返回结果与最终类型。
func parseLinkSearch(link, searchType string) ([]model.Song, []model.Playlist, string, string) {
	songs := []model.Song{}
	playlists := []model.Playlist{}

	src := core.DetectSource(link)
	if src == "" {
		return songs, playlists, searchType, "不支持该链接的解析，或无法识别来源"
	}

	if parseFn := core.GetParseFunc(src); parseFn != nil {
		if song, err := parseFn(link); err == nil {
			songs = append(songs, *song)
			return songs, playlists, "song", ""
		}
	}
	if parsePlaylistFn := core.GetParsePlaylistFunc(src); parsePlaylistFn != nil {
		if playlist, plSongs, err := parsePlaylistFn(link); err == nil {
			if searchType == "playlist" && playlist != nil {
				playlists = append(playlists, *playlist)
				return songs, playlists, "playlist", ""
			}
			songs = append(songs, plSongs...)
			return songs, playlists, "song", ""
		}
	}
	if parseAlbumFn := core.GetParseAlbumFunc(src); parseAlbumFn != nil {
		if album, alSongs, err := parseAlbumFn(link); err == nil {
			if searchType == "album" && album != nil {
				playlists = append(playlists, *album)
				return songs, playlists, "album", ""
			}
			songs = append(songs, alSongs...)
			return songs, playlists, "song", ""
		}
	}
	return songs, playlists, searchType, fmt.Sprintf("解析失败: 暂不支持 %s 平台的此链接类型或解析出错", src)
}

// loadPlaylistTabsJSON 按源加载歌单,整理为前端友好的分栏结构。
func loadPlaylistTabsJSON(sources []string, loader func(string) ([]model.Playlist, error)) []gin.H {
	tabs := []gin.H{}
	for _, src := range sources {
		playlists, err := loader(src)
		if playlists == nil {
			playlists = []model.Playlist{}
		}
		for i := range playlists {
			playlists[i].Source = src
		}
		tab := gin.H{
			"source":      src,
			"source_name": core.GetSourceDescription(src),
			"playlists":   playlists,
		}
		if err != nil {
			tab["error"] = err.Error()
		}
		tabs = append(tabs, tab)
	}
	return tabs
}

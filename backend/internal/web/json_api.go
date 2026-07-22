package web

import (
	"encoding/json"
	"fmt"
	"log"
	"sort"
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
// 安全模型:健康检查与登录/setup/register 公开;搜索/歌单/专辑/推荐等读接口默认要求登录。
// 改写状态的敏感接口(扫码登录写 cookie、清除 cookie)挂到管理员鉴权之后。
func RegisterJSONAPIRoutes(r *gin.Engine, opts StartOptions) {
	api := r.Group("/api/v1")

	api.GET("/healthz", func(c *gin.Context) {
		c.JSON(200, gin.H{"app": "melodex", "status": "ok"})
	})

	// 账号鉴权接口(登录/登出/注册/初始化/当前用户)。见 auth_api.go。
	registerAuthAPIRoutes(api, opts)

	userSecure := api.Group("")
	if opts.DisableAuth {
		userSecure.Use(desktopUserMiddleware())
	} else {
		userSecure.Use(authRequired())
	}

	// 可用音乐源列表(前端 source 选择用)
	userSecure.GET("/sources", func(c *gin.Context) {
		c.JSON(200, gin.H{
			"all":      core.GetAllSourceNames(),
			"default":  core.GetDefaultSourceNames(),
			"playlist": core.GetPlaylistSourceNames(),
			"album":    core.GetAlbumSourceNames(),
		})
	})

	// 桌面端音频播放票据:让 Qt 原生播放器直连音频流,不再经 Python 搬运媒体字节。
	// 票据只绑定一条 GET /music/download?stream=1 查询,不可转作下载或写操作。
	userSecure.POST("/playback_ticket", jsonPlaybackTicketHandler)

	// 搜索会放大到所有上游音源,加 per-IP 限流(30 次/分钟)防滥用。
	userSecure.GET("/search", rateLimitMiddleware(searchRateLimiter), jsonSearchHandler)
	userSecure.DELETE("/search_cache", jsonSearchCacheDeleteHandler)
	userSecure.GET("/search_suggestions", jsonSearchSuggestionsHandler)
	userSecure.GET("/recognize/status", jsonRecognitionStatusHandler)
	userSecure.POST("/recognize", rateLimitMiddleware(recognitionRateLimiter), jsonRecognizeAudioHandler)

	// 歌单详情:返回歌曲列表
	userSecure.GET("/playlist", func(c *gin.Context) {
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
		args := apiCacheArgs{Source: src, ID: id}
		key := apiCacheKey(apiCacheNamespacePlaylistDetail, args)
		if entry, ok := getAPICacheEntry(key); ok {
			var cached jsonSongListResponse
			if decodeAPICachePayload(entry, &cached) {
				cached.cachedResponseMeta = cacheMetaForEntry(entry)
				if !entry.Fresh {
					refreshAPICacheAsync(key, apiCacheNamespacePlaylistDetail, args)
				}
				if len(cached.Songs) > 0 {
					warmQualityCache(cached.Songs, 6)
				}
				c.JSON(200, cached)
				return
			}
		}
		out := buildSongListDetailResponse("playlist", id, src)
		if len(out.Songs) > 0 {
			putAPICache(key, apiCacheNamespacePlaylistDetail, args, out)
			warmQualityCache(out.Songs, 6)
		}
		c.JSON(200, out)
	})

	// 专辑详情:返回歌曲列表
	userSecure.GET("/album", func(c *gin.Context) {
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
		args := apiCacheArgs{Source: src, ID: id}
		key := apiCacheKey(apiCacheNamespaceAlbumDetail, args)
		if entry, ok := getAPICacheEntry(key); ok {
			var cached jsonSongListResponse
			if decodeAPICachePayload(entry, &cached) {
				cached.cachedResponseMeta = cacheMetaForEntry(entry)
				if !entry.Fresh {
					refreshAPICacheAsync(key, apiCacheNamespaceAlbumDetail, args)
				}
				if len(cached.Songs) > 0 {
					warmQualityCache(cached.Songs, 6)
				}
				c.JSON(200, cached)
				return
			}
		}
		out := buildSongListDetailResponse("album", id, src)
		if len(out.Songs) > 0 {
			putAPICache(key, apiCacheNamespaceAlbumDetail, args, out)
			warmQualityCache(out.Songs, 6)
		}
		c.JSON(200, out)
	})

	// 每日推荐歌单:按源返回歌单列表
	userSecure.GET("/recommend", func(c *gin.Context) {
		sources := filterAvailableSources(c.QueryArray("sources"), core.GetRecommendSourceNames())
		args := apiCacheArgs{Sources: sources}
		key := apiCacheKey(apiCacheNamespaceRecommend, args)
		if entry, ok := getAPICacheEntry(key); ok {
			var cached jsonPlaylistTabsResponse
			if decodeAPICachePayload(entry, &cached) {
				cached.cachedResponseMeta = cacheMetaForEntry(entry)
				if !entry.Fresh {
					refreshAPICacheAsync(key, apiCacheNamespaceRecommend, args)
				}
				c.JSON(200, cached)
				return
			}
		}
		out := buildRecommendResponse(sources)
		if playlistTabsHaveItems(out.Tabs) {
			putAPICache(key, apiCacheNamespaceRecommend, args, out)
		}
		c.JSON(200, out)
	})

	// 我在各平台创建/收藏的个人歌单(需在设置里登录对应平台 cookie)。
	// 依登录态返回,不缓存:各用户/各登录态的歌单不同,缓存会串。
	userSecure.GET("/user_playlists", func(c *gin.Context) {
		sources := filterAvailableSources(c.QueryArray("sources"), userPlaylistSourceNamesGetter())
		out := jsonPlaylistTabsResponse{Tabs: loadPlaylistTabsJSON(sources, func(src string) ([]model.Playlist, error) {
			fn := userPlaylistsFuncProvider(src)
			if fn == nil {
				return nil, fmt.Errorf("该源不支持个人歌单")
			}
			return fn(1, 50)
		})}
		c.JSON(200, out)
	})

	// 歌单分类列表
	userSecure.GET("/playlist_categories", func(c *gin.Context) {
		sources := filterAvailableSources(c.QueryArray("sources"), core.GetPlaylistCategorySourceNames())
		args := apiCacheArgs{Sources: sources}
		key := apiCacheKey(apiCacheNamespacePlaylistCategory, args)
		if entry, ok := getAPICacheEntry(key); ok {
			var cached jsonPlaylistCategoriesResponse
			if decodeAPICachePayload(entry, &cached) {
				cached.cachedResponseMeta = cacheMetaForEntry(entry)
				if !entry.Fresh {
					refreshAPICacheAsync(key, apiCacheNamespacePlaylistCategory, args)
				}
				c.JSON(200, cached)
				return
			}
		}
		out := buildPlaylistCategoriesResponse(sources)
		if playlistCategoriesHaveItems(out.Sources) {
			putAPICache(key, apiCacheNamespacePlaylistCategory, args, out)
		}
		c.JSON(200, out)
	})

	// 某分类下的歌单
	userSecure.GET("/category_playlists", func(c *gin.Context) {
		source := strings.TrimSpace(c.Query("source"))
		categoryID := strings.TrimSpace(c.Query("category_id"))
		fn := core.GetCategoryPlaylistsFunc(source)
		if source == "" || fn == nil {
			c.JSON(400, gin.H{"error": "该源不支持歌单分类"})
			return
		}
		args := apiCacheArgs{Source: source, CategoryID: categoryID}
		key := apiCacheKey(apiCacheNamespaceCategoryPlaylists, args)
		if entry, ok := getAPICacheEntry(key); ok {
			var cached jsonPlaylistListResponse
			if decodeAPICachePayload(entry, &cached) {
				cached.cachedResponseMeta = cacheMetaForEntry(entry)
				if !entry.Fresh {
					refreshAPICacheAsync(key, apiCacheNamespaceCategoryPlaylists, args)
				}
				c.JSON(200, cached)
				return
			}
		}
		out := buildCategoryPlaylistsResponse(source, categoryID)
		if len(out.Playlists) > 0 {
			putAPICache(key, apiCacheNamespaceCategoryPlaylists, args, out)
		}
		c.JSON(200, out)
	})

	// 支持二维码登录的源(只读,登录后可见)
	userSecure.GET("/qr_login/sources", func(c *gin.Context) {
		c.JSON(200, gin.H{
			"sources":        core.GetQRLoginSourceNames(),
			"cookie_sources": core.GetCookieSourceNames(),
		})
	})

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
		if result != nil && result.Status != model.QRLoginStatusWaiting {
			log.Printf("qr login status source=%s status=%s message=%q extra=%v", source, result.Status, result.Message, result.Extra)
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
		details := map[string]core.CookieStatusDetail{}
		verify := strings.TrimSpace(c.Query("verify")) == "1"
		detailCache := map[string]core.CookieStatusDetail{}

		statusFor := func(source string) core.CookieStatusDetail {
			cookieSource := qrLoginCookieSource(source)
			if detail, ok := detailCache[cookieSource]; ok {
				detail.Source = source
				return detail
			}
			detail := core.BuildCookieStatusDetail(cookieSource, all[cookieSource], verify)
			detailCache[cookieSource] = detail
			detail.Source = source
			return detail
		}

		for src, v := range all {
			detail := core.BuildCookieStatusDetail(src, v, verify)
			status[src] = detail.Saved
			details[src] = detail
		}
		for _, src := range core.GetCookieSourceNames() {
			detail := statusFor(src)
			status[src] = detail.Saved
			details[src] = detail
		}
		c.JSON(200, gin.H{"logged_in": status, "details": details})
	})

	// 清除某源 cookie(退出登录)。SetAll 对空值执行删除(见 core.CookieManager.SetAll)。
	api.DELETE("/cookies/:source", func(c *gin.Context) {
		source := strings.TrimSpace(c.Param("source"))
		core.CM.SetAll(map[string]string{qrLoginCookieSource(source): ""})
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
		core.CM.SetAll(map[string]string{qrLoginCookieSource(source): strings.TrimSpace(req.Cookie)})
		core.CM.Save()
		c.JSON(200, gin.H{"status": "ok"})
	})
}

// jsonSearchSongResult 在 model.Song 基础上附带前端友好的展示字段。
type jsonSearchResponse struct {
	Songs       []model.Song     `json:"songs"`
	Playlists   []model.Playlist `json:"playlists"`
	Type        string           `json:"type"`
	Keyword     string           `json:"keyword"`
	ExactArtist string           `json:"exact_artist,omitempty"`
	Sources     []string         `json:"sources"`
	Error       string           `json:"error,omitempty"`
	cachedResponseMeta
}

type jsonSongListResponse struct {
	Songs  []model.Song `json:"songs"`
	Type   string       `json:"type"`
	Source string       `json:"source"`
	Link   string       `json:"link"`
	Error  string       `json:"error,omitempty"`
	cachedResponseMeta
}

type jsonPlaylistTabsResponse struct {
	Tabs []jsonPlaylistTab `json:"tabs"`
	cachedResponseMeta
}

type jsonPlaylistTab struct {
	Source     string           `json:"source"`
	SourceName string           `json:"source_name"`
	Playlists  []model.Playlist `json:"playlists"`
	Error      string           `json:"error,omitempty"`
}

type jsonPlaylistCategoriesResponse struct {
	Sources []jsonPlaylistCategorySource `json:"sources"`
	cachedResponseMeta
}

type jsonPlaylistCategorySource struct {
	Source     string                   `json:"source"`
	SourceName string                   `json:"source_name"`
	Categories []model.PlaylistCategory `json:"categories"`
	Error      string                   `json:"error,omitempty"`
}

type jsonPlaylistListResponse struct {
	Playlists []model.Playlist `json:"playlists"`
	Source    string           `json:"source"`
	Error     string           `json:"error,omitempty"`
	cachedResponseMeta
}

// jsonSearchHandler 复用 core 的并发多源搜索逻辑,返回结构化 JSON
// (对应原 music.go 的 /music/search,但用 c.JSON 替代 renderIndex 的 HTML 片段)。
func jsonSearchHandler(c *gin.Context) {
	keyword := strings.TrimSpace(c.Query("q"))
	searchType := c.DefaultQuery("type", "song")
	exactArtist := strings.TrimSpace(c.Query("exact_artist"))
	sources := c.QueryArray("sources")
	skipWarm, _ := strconv.ParseBool(c.DefaultQuery("skip_warm", "false"))

	if len(sources) == 0 {
		sources = defaultSourcesForSearchType(searchType)
	}

	resp := jsonSearchResponse{
		Songs:       []model.Song{},
		Playlists:   []model.Playlist{},
		Type:        searchType,
		Keyword:     keyword,
		ExactArtist: exactArtist,
		Sources:     sources,
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
		if !skipWarm && isTrackSearchType(resp.Type) && len(resp.Songs) > 0 {
			warmQualityCache(resp.Songs, 6)
		}
		if errMsg != "" {
			c.JSON(200, resp)
			return
		}
	} else {
		// 关键词搜索:先查结果缓存(含完整元数据),命中直接返回。
		cacheKey := searchCacheKey(searchType, keyword, exactArtist, sources)
		if entry, ok := getSearchCacheEntry(cacheKey); ok {
			cached := entry.Response
			cached.cachedResponseMeta = cachedResponseMeta{
				Cached:     true,
				Refreshing: !entry.Fresh || entry.Refreshing,
				CachedAt:   &entry.CreatedAt,
			}
			applyAlbumSourcePreference(&cached)
			recordSearchHistory(currentUserID(c), keyword, cached.Type)
			if !entry.Fresh {
				refreshSearchCacheAsync(cacheKey, searchType, keyword, exactArtist, sources, !skipWarm)
			}
			if !skipWarm && isTrackSearchType(cached.Type) && len(cached.Songs) > 0 {
				warmQualityCache(cached.Songs, 6)
			}
			c.JSON(200, cached)
			return
		}

		resp = buildKeywordSearchResponse(keyword, searchType, exactArtist, sources)

		// 写缓存(排序/过滤后的最终结果)+ 记搜索历史。
		putCachedSearch(cacheKey, resp)
		recordSearchHistory(currentUserID(c), keyword, resp.Type)
		if !skipWarm && isTrackSearchType(resp.Type) && len(resp.Songs) > 0 {
			warmQualityCache(resp.Songs, 6)
		}
		c.JSON(200, resp)
		return
	}

	c.JSON(200, resp)
}

func jsonSearchCacheDeleteHandler(c *gin.Context) {
	keyword := strings.TrimSpace(c.Query("q"))
	if keyword == "" {
		c.JSON(400, gin.H{"error": "搜索关键词不能为空"})
		return
	}
	if strings.HasPrefix(keyword, "http") {
		c.JSON(200, gin.H{"deleted": 0})
		return
	}

	exactArtist := strings.TrimSpace(c.Query("exact_artist"))
	requestedSources := c.QueryArray("sources")
	types := c.QueryArray("type")
	if len(types) == 0 {
		types = []string{"song"}
	}

	var deleted int64
	seen := make(map[string]struct{}, len(types))
	for _, rawType := range types {
		searchType := strings.TrimSpace(rawType)
		if searchType == "" {
			continue
		}
		sources := append([]string(nil), requestedSources...)
		if len(sources) == 0 {
			sources = defaultSourcesForSearchType(searchType)
		}
		key := searchCacheKey(searchType, keyword, exactArtist, sources)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		n, err := deleteCachedSearchKey(key)
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		deleted += n
	}

	c.JSON(200, gin.H{"deleted": deleted})
}

var searchCacheRefreshInFlight sync.Map

func isTrackSearchType(searchType string) bool {
	return searchType == "song" || searchType == "lyric"
}

func buildKeywordSearchResponse(keyword, searchType, exactArtist string, sources []string) jsonSearchResponse {
	resp := jsonSearchResponse{
		Songs:       []model.Song{},
		Playlists:   []model.Playlist{},
		Type:        searchType,
		Keyword:     keyword,
		ExactArtist: exactArtist,
		Sources:     append([]string(nil), sources...),
	}

	songs, playlists := concurrentKeywordSearch(keyword, searchType, sources)
	resp.Songs = songs
	resp.Playlists = playlists

	// 综合排序(与 Subsonic search3 一致):相关性 + 上游名次 + 原唱信号 − 翻唱降权。
	if resp.Type == "song" && keyword != "" && len(resp.Songs) > 0 {
		sortSongsByRelevance(resp.Songs, keyword)
	}
	if isTrackSearchType(resp.Type) && exactArtist != "" && len(resp.Songs) > 0 {
		resp.Songs = filterSongsByExactArtist(resp.Songs, exactArtist)
	}
	applyAlbumSourcePreference(&resp)
	return resp
}

// applyAlbumSourcePreference 让已保存平台凭据的专辑优先展示。
// 搜索缓存全局共享且有效期较长，因此每次响应（包括缓存命中）都按当前凭据重新排序；
// 同一凭据分组内按请求源顺序排列，同一来源内部保留上游原始名次。
func applyAlbumSourcePreference(resp *jsonSearchResponse) {
	if resp == nil || resp.Type != "album" || len(resp.Playlists) < 2 {
		return
	}
	prioritizeAlbumsBySource(resp.Playlists, resp.Sources, core.CM.GetAll())
}

func prioritizeAlbumsBySource(albums []model.Playlist, sources []string, cookies map[string]string) {
	if len(albums) < 2 {
		return
	}

	sourceOrder := make(map[string]int, len(sources))
	for index, source := range sources {
		if _, exists := sourceOrder[source]; !exists {
			sourceOrder[source] = index
		}
	}
	unknownSourceRank := len(sources)

	sort.SliceStable(albums, func(i, j int) bool {
		leftSource := strings.TrimSpace(albums[i].Source)
		rightSource := strings.TrimSpace(albums[j].Source)
		leftCredentialed := strings.TrimSpace(cookies[leftSource]) != ""
		rightCredentialed := strings.TrimSpace(cookies[rightSource]) != ""
		if leftCredentialed != rightCredentialed {
			return leftCredentialed
		}

		leftRank, ok := sourceOrder[leftSource]
		if !ok {
			leftRank = unknownSourceRank
		}
		rightRank, ok := sourceOrder[rightSource]
		if !ok {
			rightRank = unknownSourceRank
		}
		return leftRank < rightRank
	})
}

func refreshSearchCacheAsync(key, searchType, keyword, exactArtist string, sources []string, warmQuality bool) {
	if strings.TrimSpace(key) == "" || strings.TrimSpace(keyword) == "" {
		return
	}
	if _, loaded := searchCacheRefreshInFlight.LoadOrStore(key, struct{}{}); loaded {
		return
	}
	go func() {
		defer searchCacheRefreshInFlight.Delete(key)
		resp := buildKeywordSearchResponse(keyword, searchType, exactArtist, sources)
		putCachedSearch(key, resp)
		if warmQuality && isTrackSearchType(resp.Type) && len(resp.Songs) > 0 {
			warmQualityCache(resp.Songs, 6)
		}
	}()
}

func buildSongListDetailResponse(contentType, id, src string) jsonSongListResponse {
	resp := jsonSongListResponse{
		Songs:  []model.Song{},
		Type:   contentType,
		Source: src,
		Link:   core.GetOriginalLink(src, id, contentType),
	}
	var fn func(string) ([]model.Song, error)
	if contentType == "album" {
		fn = core.GetAlbumDetailFunc(src)
	} else {
		fn = core.GetPlaylistDetailFunc(src)
	}
	if fn == nil {
		resp.Error = fmt.Sprintf("该源不支持查看%s详情", contentType)
		return resp
	}
	songs, err := fn(id)
	if songs == nil {
		songs = []model.Song{}
	}
	for i := range songs {
		if strings.TrimSpace(songs[i].Source) == "" {
			songs[i].Source = src
		}
	}
	resp.Songs = songs
	if err != nil {
		if contentType == "album" {
			resp.Error = fmt.Sprintf("获取专辑失败: %v", err)
		} else {
			resp.Error = fmt.Sprintf("获取歌单失败: %v", err)
		}
	}
	return resp
}

func buildRecommendResponse(sources []string) jsonPlaylistTabsResponse {
	return jsonPlaylistTabsResponse{Tabs: loadPlaylistTabsJSON(sources, func(src string) ([]model.Playlist, error) {
		fn := core.GetRecommendFunc(src)
		if fn == nil {
			return nil, fmt.Errorf("该源不支持推荐歌单")
		}
		return fn()
	})}
}

func buildPlaylistCategoriesResponse(sources []string) jsonPlaylistCategoriesResponse {
	result := []jsonPlaylistCategorySource{}
	for _, src := range sources {
		fn := core.GetPlaylistCategoriesFunc(src)
		if fn == nil {
			continue
		}
		cats, err := fn()
		entry := jsonPlaylistCategorySource{
			Source:     src,
			SourceName: core.GetSourceDescription(src),
			Categories: cats,
		}
		if entry.Categories == nil {
			entry.Categories = []model.PlaylistCategory{}
		}
		if err != nil {
			entry.Error = err.Error()
		}
		result = append(result, entry)
	}
	return jsonPlaylistCategoriesResponse{Sources: result}
}

func buildCategoryPlaylistsResponse(source, categoryID string) jsonPlaylistListResponse {
	resp := jsonPlaylistListResponse{Playlists: []model.Playlist{}, Source: source}
	fn := core.GetCategoryPlaylistsFunc(source)
	if fn == nil {
		resp.Error = "该源不支持歌单分类"
		return resp
	}
	playlists, err := fn(categoryID, 1, 120)
	if playlists == nil {
		playlists = []model.Playlist{}
	}
	for i := range playlists {
		playlists[i].Source = source
	}
	resp.Playlists = playlists
	if err != nil {
		resp.Error = fmt.Sprintf("获取分类歌单失败: %v", err)
	}
	return resp
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
			case "lyric":
				if fn := core.GetLyricSearchFunc(s); fn != nil {
					if res, err := fn(keyword); err == nil {
						for i := range res {
							res[i].Source = s
							if res[i].Extra == nil {
								res[i].Extra = map[string]string{}
							}
							res[i].Extra["_rank"] = strconv.Itoa(i)
						}
						res = augmentLyricSearchOriginals(s, res, searchInferredLyricOriginalCandidates)
						mu.Lock()
						allSongs = append(allSongs, res...)
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

func augmentLyricSearchOriginals(source string, songs []model.Song, searchFn func(string) ([]model.Song, error)) []model.Song {
	if len(songs) == 0 || searchFn == nil {
		return songs
	}

	out := make([]model.Song, 0, len(songs)+4)
	seen := make(map[string]struct{}, len(songs)+4)
	for _, song := range songs {
		for _, candidate := range findInferredLyricOriginals(source, song, searchFn) {
			key := songResultKey(candidate)
			if key == "" {
				continue
			}
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, candidate)
		}

		key := songResultKey(song)
		if key != "" {
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
		}
		out = append(out, song)
	}
	return out
}

func searchInferredLyricOriginalCandidates(keyword string) ([]model.Song, error) {
	songs, _ := concurrentKeywordSearch(keyword, "song", defaultSourcesForSearchType("song"))
	return songs, nil
}

func findInferredLyricOriginals(source string, song model.Song, searchFn func(string) ([]model.Song, error)) []model.Song {
	artist, title, ok := inferredOriginalFromQuotedTitle(song.Name)
	if !ok || artistMatches(song.Artist, artist) {
		return nil
	}

	results, err := searchFn(title + " " + artist)
	if err != nil {
		return nil
	}

	out := []model.Song{}
	targetTitle := normalizeLookupText(title)
	for i, candidate := range results {
		if normalizeLookupText(candidate.Name) != targetTitle || !artistMatches(candidate.Artist, artist) {
			continue
		}
		if strings.TrimSpace(candidate.Source) == "" {
			candidate.Source = source
		}
		if candidate.Extra == nil {
			candidate.Extra = map[string]string{}
		}
		copyLyricMatchExtra(candidate.Extra, song.Extra)
		candidate.Extra["search_match"] = "lyric"
		candidate.Extra["lyric_inferred_original"] = "1"
		candidate.Extra["lyric_inferred_from"] = strings.TrimSpace(song.Name)
		candidate.Extra["_rank"] = inferredLyricOriginalRank(song, i)
		out = append(out, candidate)
	}
	return out
}

func inferredLyricOriginalRank(song model.Song, candidateRank int) string {
	rank := 0
	if song.Extra != nil {
		if parsed, err := strconv.Atoi(song.Extra["_rank"]); err == nil && parsed >= 0 {
			rank = parsed
		}
	}
	return strconv.Itoa(rank*1000 + candidateRank)
}

func copyLyricMatchExtra(dst, src map[string]string) {
	if dst == nil || src == nil {
		return
	}
	for _, key := range []string{"lyric_match", "search_match"} {
		if value := strings.TrimSpace(src[key]); value != "" {
			dst[key] = value
		}
	}
}

func inferredOriginalFromQuotedTitle(name string) (artist string, title string, ok bool) {
	name = strings.TrimSpace(name)
	start := strings.Index(name, "《")
	end := strings.LastIndex(name, "》")
	if start <= 0 || end <= start+len("《") {
		return "", "", false
	}
	artist = strings.TrimSpace(name[:start])
	title = strings.TrimSpace(name[start+len("《") : end])
	if artist == "" || title == "" {
		return "", "", false
	}
	return artist, title, true
}

func artistMatches(value, target string) bool {
	targetNorm := normalizeArtistToken(target)
	if targetNorm == "" {
		return false
	}
	for _, token := range splitArtistTokens(value) {
		if normalizeArtistToken(token) == targetNorm {
			return true
		}
	}
	return false
}

func songResultKey(song model.Song) string {
	source := strings.TrimSpace(song.Source)
	id := strings.TrimSpace(song.ID)
	if id == "" && song.Extra != nil {
		id = strings.TrimSpace(song.Extra["songmid"])
	}
	if source != "" && id != "" {
		return source + "\x00" + id
	}
	name := normalizeLookupText(song.Name)
	artist := normalizeLookupText(song.Artist)
	if source == "" || name == "" || artist == "" {
		return ""
	}
	return source + "\x00" + name + "\x00" + artist
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
func loadPlaylistTabsJSON(sources []string, loader func(string) ([]model.Playlist, error)) []jsonPlaylistTab {
	tabs := []jsonPlaylistTab{}
	for _, src := range sources {
		playlists, err := loader(src)
		if playlists == nil {
			playlists = []model.Playlist{}
		}
		for i := range playlists {
			playlists[i].Source = src
		}
		tab := jsonPlaylistTab{
			Source:     src,
			SourceName: core.GetSourceDescription(src),
			Playlists:  playlists,
		}
		if err != nil {
			tab.Error = err.Error()
		}
		tabs = append(tabs, tab)
	}
	return tabs
}

func playlistTabsHaveItems(tabs []jsonPlaylistTab) bool {
	for _, tab := range tabs {
		if len(tab.Playlists) > 0 {
			return true
		}
	}
	return false
}

func playlistCategoriesHaveItems(sources []jsonPlaylistCategorySource) bool {
	for _, source := range sources {
		if len(source.Categories) > 0 {
			return true
		}
	}
	return false
}

func refreshAPICacheAsync(key, namespace string, args apiCacheArgs) {
	if strings.TrimSpace(key) == "" {
		return
	}
	if _, loaded := apiCacheRefreshFlight.LoadOrStore(key, struct{}{}); loaded {
		return
	}
	go func() {
		defer apiCacheRefreshFlight.Delete(key)
		switch namespace {
		case apiCacheNamespaceRecommend:
			out := buildRecommendResponse(args.Sources)
			if playlistTabsHaveItems(out.Tabs) {
				putAPICache(key, namespace, args, out)
			}
		case apiCacheNamespacePlaylistDetail:
			out := buildSongListDetailResponse("playlist", args.ID, args.Source)
			if len(out.Songs) > 0 {
				putAPICache(key, namespace, args, out)
				warmQualityCache(out.Songs, 6)
			}
		case apiCacheNamespaceAlbumDetail:
			out := buildSongListDetailResponse("album", args.ID, args.Source)
			if len(out.Songs) > 0 {
				putAPICache(key, namespace, args, out)
				warmQualityCache(out.Songs, 6)
			}
		case apiCacheNamespacePlaylistCategory:
			out := buildPlaylistCategoriesResponse(args.Sources)
			if playlistCategoriesHaveItems(out.Sources) {
				putAPICache(key, namespace, args, out)
			}
		case apiCacheNamespaceCategoryPlaylists:
			out := buildCategoryPlaylistsResponse(args.Source, args.CategoryID)
			if len(out.Playlists) > 0 {
				putAPICache(key, namespace, args, out)
			}
		}
	}()
}

func refreshAPICacheRowAsync(row apiCacheRow) {
	var args apiCacheArgs
	if err := json.Unmarshal([]byte(row.Args), &args); err != nil {
		return
	}
	refreshAPICacheAsync(row.Key, row.Namespace, args)
}

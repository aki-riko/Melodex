package web

import (
	"encoding/json"
	"fmt"
	"os"
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

	// 搜索会放大到所有上游音源,加 per-IP 限流(30 次/分钟)防滥用。
	userSecure.GET("/search", rateLimitMiddleware(searchRateLimiter), jsonSearchHandler)

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
		for _, src := range core.GetCookieSourceNames() {
			cookieSource := qrLoginCookieSource(src)
			status[src] = strings.TrimSpace(all[cookieSource]) != ""
		}
		c.JSON(200, gin.H{"logged_in": status})
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
		if isTrackSearchType(resp.Type) && len(resp.Songs) > 0 {
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
			recordSearchHistory(currentUserID(c), keyword, cached.Type)
			if !entry.Fresh {
				refreshSearchCacheAsync(cacheKey, searchType, keyword, exactArtist, sources)
			}
			if isTrackSearchType(cached.Type) && len(cached.Songs) > 0 {
				warmQualityCache(cached.Songs, 6)
			}
			c.JSON(200, cached)
			return
		}

		resp = buildKeywordSearchResponse(keyword, searchType, exactArtist, sources)

		// 写缓存(排序/过滤后的最终结果)+ 记搜索历史。
		putCachedSearch(cacheKey, resp)
		recordSearchHistory(currentUserID(c), keyword, resp.Type)
		if isTrackSearchType(resp.Type) && len(resp.Songs) > 0 {
			warmQualityCache(resp.Songs, 6)
		}
		c.JSON(200, resp)
		return
	}

	c.JSON(200, resp)
}

var searchCacheRefreshInFlight sync.Map

const (
	lyricSearchCandidateLimitEnv  = "MUSIC_DL_LYRIC_SEARCH_CANDIDATE_LIMIT"
	lyricSearchConcurrencyEnv     = "MUSIC_DL_LYRIC_SEARCH_CONCURRENCY"
	defaultLyricCandidateLimit    = 80
	defaultLyricSearchConcurrency = 6
)

func isTrackSearchType(searchType string) bool {
	return searchType == "song" || searchType == "lyric"
}

var fetchLyricForSearch = func(song model.Song) (string, error) {
	fn := core.GetLyricFunc(song.Source)
	if fn == nil {
		return "", fmt.Errorf("source %s does not support lyrics", song.Source)
	}
	s := song
	return fn(&s)
}

func filterSongsByLyric(keyword string, songs []model.Song) []model.Song {
	needle := compactLyricSearchText(keyword)
	if needle == "" || len(songs) == 0 {
		return songs
	}

	limit := len(songs)
	if maxCandidates := lyricSearchCandidateLimit(); limit > maxCandidates {
		limit = maxCandidates
	}

	type matchResult struct {
		song model.Song
		ok   bool
	}
	results := make([]matchResult, limit)
	sem := make(chan struct{}, lyricSearchConcurrency())
	var wg sync.WaitGroup

	for i := 0; i < limit; i++ {
		i := i
		song := songs[i]
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			raw, err := fetchLyricForSearch(song)
			if err != nil || !lyricTextContains(raw, needle) {
				return
			}
			if song.Extra == nil {
				song.Extra = map[string]string{}
			}
			song.Extra["lyric_match"] = extractLyricMatchLine(raw, needle)
			results[i] = matchResult{song: song, ok: true}
		}()
	}
	wg.Wait()

	out := make([]model.Song, 0, limit)
	for _, result := range results {
		if result.ok {
			out = append(out, result.song)
		}
	}
	return out
}

func lyricSearchCandidateLimit() int {
	return positiveIntFromEnv(lyricSearchCandidateLimitEnv, defaultLyricCandidateLimit)
}

func lyricSearchConcurrency() int {
	n := positiveIntFromEnv(lyricSearchConcurrencyEnv, defaultLyricSearchConcurrency)
	if n > 16 {
		return 16
	}
	return n
}

func positiveIntFromEnv(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	if n, err := strconv.Atoi(raw); err == nil && n > 0 {
		return n
	}
	return fallback
}

func lyricTextContains(raw string, needle string) bool {
	return strings.Contains(compactLyricSearchText(raw), needle)
}

func compactLyricSearchText(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	text = lrcTimestampRe.ReplaceAllString(text, "")
	text = strings.ToLower(text)
	return strings.Join(strings.Fields(text), "")
}

func extractLyricMatchLine(raw string, needle string) string {
	for _, rawLine := range strings.Split(raw, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || lrcTagLineRe.MatchString(line) {
			continue
		}
		line = strings.TrimSpace(lrcTimestampRe.ReplaceAllString(line, ""))
		if line == "" || !strings.Contains(compactLyricSearchText(line), needle) {
			continue
		}
		runes := []rune(line)
		if len(runes) > 80 {
			return string(runes[:80]) + "..."
		}
		return line
	}
	return ""
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
	if isTrackSearchType(resp.Type) && keyword != "" && len(resp.Songs) > 0 {
		sortSongsByRelevance(resp.Songs, keyword)
	}
	if resp.Type == "lyric" && keyword != "" && len(resp.Songs) > 0 {
		resp.Songs = filterSongsByLyric(keyword, resp.Songs)
	}
	if isTrackSearchType(resp.Type) && exactArtist != "" && len(resp.Songs) > 0 {
		resp.Songs = filterSongsByExactArtist(resp.Songs, exactArtist)
	}
	return resp
}

func refreshSearchCacheAsync(key, searchType, keyword, exactArtist string, sources []string) {
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
		if isTrackSearchType(resp.Type) && len(resp.Songs) > 0 {
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

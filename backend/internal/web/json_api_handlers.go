package web

// /api/v1 下各 JSON 端点的具名 handler(2026-11 全库扫描拆分)。
//
// 为什么单独拆出来:RegisterJSONAPIRoutes 原本把 7 个 handler 以匿名闭包内联,
// 于是它单函数 128~221 行、既做路由装配又藏业务逻辑,而且**没有一个 handler
// 可以被单独测试**(只能起整条路由)。这里只是搬运,行为一字未改。
//
// 内联闭包与具名函数的取舍:三行以内、纯装配的闭包(如 serveSongListDetail 的
// 两个薄包装)保留内联更清楚;超过十几行、有参数校验和分支的,一律具名 ——
// 后者是"能单测 + 能被 grep 到"的分界线。

import (
	"fmt"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/gin-gonic/gin"
)

// jsonHealthHandler 健康检查。不带任何依赖,便于探针调用。
func jsonHealthHandler(c *gin.Context) {
	c.JSON(200, gin.H{"app": "melodex", "status": "ok"})
}

// jsonSourcesHandler 返回可用音乐源列表(前端 source 选择用)。
//
// 注意:它保持"只读常量清单"的语义 —— 不查 cookie 状态、不探测上游可用性,
// 所以可以低频缓存。真实可用性由各业务接口的错误体现。
func jsonSourcesHandler(c *gin.Context) {
	c.JSON(200, gin.H{
		"all":      core.GetAllSourceNames(),
		"default":  core.GetDefaultSourceNames(),
		"playlist": core.GetPlaylistSourceNames(),
		"album":    core.GetAlbumSourceNames(),
	})
}

// serveSongListDetail 是歌单详情与专辑详情的共同实现。
//
// 两者除了「用哪个 provider 判定该源是否支持 + 缓存 namespace」以外逐字相同,
// 所以合并成一个函数;缓存规格由 newSongListCacheSpec 定义(见 api_cache_spec.go),
// 请求路径与后台刷新共用同一份 —— 不会出现两边行为分叉。
func serveSongListDetail(c *gin.Context, isAlbum bool) {
	id := c.Query("id")
	src := c.Query("source")
	if id == "" || src == "" {
		c.JSON(400, gin.H{"error": "缺少参数 id/source"})
		return
	}
	contentType := "playlist"
	supported := core.GetPlaylistDetailFunc(src) != nil
	if isAlbum {
		contentType = "album"
		supported = core.GetAlbumDetailFunc(src) != nil
	}
	if !supported {
		c.JSON(400, gin.H{"error": "该源不支持查看" + contentType + "详情"})
		return
	}
	args := apiCacheArgs{Source: src, ID: id}
	serveWithAPICache(c, newSongListCacheSpec(contentType, args), args)
}

// jsonPlaylistDetailHandler / jsonAlbumDetailHandler 是上面那个共同实现的
// 两个薄包装(仅给 gin 一个无参签名)。
func jsonPlaylistDetailHandler(c *gin.Context) { serveSongListDetail(c, false) }
func jsonAlbumDetailHandler(c *gin.Context)    { serveSongListDetail(c, true) }

// jsonRecommendHandler 每日推荐歌单(按源返回,走缓存)。
func jsonRecommendHandler(c *gin.Context) {
	sources := filterAvailableSources(c.QueryArray("sources"), core.GetRecommendSourceNames())
	args := apiCacheArgs{Sources: sources}
	serveWithAPICache(c, newRecommendCacheSpec(args), args)
}

// jsonUserPlaylistsHandler 我在各平台创建/收藏的个人歌单。
//
// **刻意不缓存**:各用户/各登录态的歌单不同,缓存会串(与 AGENTS.md 里
// "平台会员 cookie 全局共享但个人歌单按登录态"的决策配套)。
func jsonUserPlaylistsHandler(c *gin.Context) {
	sources := filterAvailableSources(c.QueryArray("sources"), userPlaylistSourceNamesGetter())
	out := jsonPlaylistTabsResponse{Tabs: loadPlaylistTabsJSON(sources, func(src string) ([]model.RemoteCollection, error) {
		fn := userPlaylistsFuncProvider(src)
		if fn == nil {
			return nil, fmt.Errorf("该源不支持个人歌单")
		}
		return fn(1, 50)
	})}
	c.JSON(200, out)
}

// jsonPlaylistCategoriesHandler 歌单分类列表(走缓存)。
func jsonPlaylistCategoriesHandler(c *gin.Context) {
	sources := filterAvailableSources(c.QueryArray("sources"), core.GetPlaylistCategorySourceNames())
	args := apiCacheArgs{Sources: sources}
	serveWithAPICache(c, newPlaylistCategoryCacheSpec(args), args)
}

// jsonCategoryPlaylistsHandler 某分类下的歌单(走缓存)。
func jsonCategoryPlaylistsHandler(c *gin.Context) {
	request := categoryPlaylistsRequestFromContext(c)
	fn := core.GetCategoryPlaylistsFunc(request.Source)
	if request.Source == "" || fn == nil {
		c.JSON(400, gin.H{"error": "该源不支持歌单分类"})
		return
	}
	args := apiCacheArgs{
		Source: request.Source, CategoryID: request.CategoryID, Page: request.Page,
	}
	serveWithAPICache(c, newCategoryPlaylistsCacheSpec(args), args)
}

// jsonQRLoginSourcesHandler 支持二维码登录的源(只读,登录后可见)。
func jsonQRLoginSourcesHandler(c *gin.Context) {
	c.JSON(200, gin.H{
		"sources":        core.GetQRLoginSourceNames(),
		"cookie_sources": core.GetCookieSourceNames(),
	})
}

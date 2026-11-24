package web

// 各缓存 namespace 的**唯一**构建定义(2026-11 全库扫描收敛)。
//
// 为什么单独一张表:原来"怎么构建一个 namespace 的响应 + 什么算有内容 +
// 要不要预热音质"这套知识被写在两个地方 ——
//   ① json_api.go 里 5 个端点各自的内联闭包;
//   ② refreshAPICacheAsync 里一段 5 分支 switch。
// 两处必须同步修改,漏一处就会出现"首查与后台刷新的行为不一致"
// (例如首查预热音质、后台刷新忘了预热,导致缓存永远不热)。
//
// 现在:spec 构造函数在这里定义一次,请求路径与后台刷新都调用它。

import (
	"sync"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/gin-gonic/gin"
)

// apiCacheWarmConcurrency 是缓存命中后预热音质的并发度。
// 提出来是因为它在原来 5 份样板里各写了一遍 `6`,改一处很容易漏另一处。
const apiCacheWarmConcurrency = 6

// cacheableResponse 是所有可缓存响应的共同能力。
//
// ★ 泛型参数必须是**指针类型**(*jsonSongListResponse 等):
//   - decodeAPICachePayload(entry, cached) 需要可写入的目标 → 指针;
//   - SetCacheMeta 用指针接收者 → 指针类型才满足接口;
//   - 值类型 + 值接收者虽然能编译,但 SetCacheMeta 改的是副本,
//     缓存元信息永远回填不上(静默失效,踩过)。
type cacheableResponse interface {
	SetCacheMeta(cachedResponseMeta)
	// songsForWarm 返回需要预热音质的歌曲;不需要预热的响应返回 nil。
	songsForWarm() []model.Track
}

// apiCacheSpec 描述一个带缓存的端点怎么构建、怎么判"值得缓存"。
// T 是响应**指针**类型。
type apiCacheSpec[T cacheableResponse] struct {
	// namespace 缓存命名空间(同时是 key 前缀与刷新分派依据)。
	namespace string
	// build 真正向上游取数据的路径。只在缓存未命中或后台刷新时调用。
	build func() T
	// hasContent 判"这个结果值得写进缓存吗"。
	// 为什么不无条件写:空结果写进去会把"上游暂时抽风/该源不支持"固化成一段
	// 时间的"真的没有",用户看到持续空列表而不是重试机会。
	hasContent func(T) bool
}

// buildAndStore 是"构建 → 判有内容 → 写缓存 → 预热"的统一流程。
//
// 请求路径与后台刷新都走它,从而保证两边行为**逐条一致**:
// 不会出现"首查写了缓存但没预热 / 刷新预热了但没写缓存"这类分叉。
func buildAndStore[T cacheableResponse](key, namespace string, args apiCacheArgs, spec apiCacheSpec[T]) T {
	out := spec.build()
	if spec.hasContent(out) {
		// out 是指针:putAPICache 收 interface{} 后做 json 序列化,
		// 指针与值序列化结果一致;原来的样板是传值,这里序列化产物不变。
		putAPICache(key, namespace, args, out)
		if songs := out.songsForWarm(); len(songs) > 0 {
			warmQualityCache(songs, apiCacheWarmConcurrency)
		}
	}
	return out
}

// serveWithAPICache 是"先查缓存、未命中则构建并回写"的统一实现。
//
// 行为与原 5 份样板逐条一致:
//   - 命中且能解码 → 回填缓存元信息 → 不新鲜则触发异步刷新
//     → 需要则预热音质 → 直接返回;
//   - 未命中或解码失败 → 走 buildAndStore → 返回。
//
// 解码失败**不**当作命中(与原实现一致):脏缓存必须能自愈成"重新构建",
// 而不是把坏数据一直返回给用户。
func serveWithAPICache[T cacheableResponse](c *gin.Context, spec apiCacheSpec[T], args apiCacheArgs) {
	key := apiCacheKey(spec.namespace, args)

	if entry, ok := getAPICacheEntry(key); ok {
		// T 是 *X,必须先分配再交给 json.Unmarshal(否则解到 nil 指针上 panic)。
		cached := newCacheable[T]()
		if decodeAPICachePayload(entry, cached) {
			cached.SetCacheMeta(cacheMetaForEntry(entry))
			if !entry.Fresh {
				refreshAPICacheAsync(key, spec.namespace, args)
			}
			if songs := cached.songsForWarm(); len(songs) > 0 {
				warmQualityCache(songs, apiCacheWarmConcurrency)
			}
			c.JSON(200, cached)
			return
		}
	}

	c.JSON(200, buildAndStore(key, spec.namespace, args, spec))
}

// refreshBuilder 是后台刷新用的无类型函数签名。
// 泛型不能放进 map(Go 限制),所以这里擦除类型;具体构建仍由 spec 决定,
// 类型安全性在 spec 定义处已由编译期保证。
type refreshBuilder func(key string, args apiCacheArgs)

var (
	refreshBuildersOnce sync.Once
	refreshBuildersByNS map[string]refreshBuilder
)

// refreshBuilders 返回 namespace → 后台重建函数的映射。
func refreshBuilders() map[string]refreshBuilder {
	refreshBuildersOnce.Do(func() {
		refreshBuildersByNS = map[string]refreshBuilder{
			apiCacheNamespaceRecommend: func(key string, args apiCacheArgs) {
				buildAndStore(key, apiCacheNamespaceRecommend, args, newRecommendCacheSpec(args))
			},
			apiCacheNamespacePlaylistDetail: func(key string, args apiCacheArgs) {
				buildAndStore(key, apiCacheNamespacePlaylistDetail, args, newSongListCacheSpec("playlist", args))
			},
			apiCacheNamespaceAlbumDetail: func(key string, args apiCacheArgs) {
				buildAndStore(key, apiCacheNamespaceAlbumDetail, args, newSongListCacheSpec("album", args))
			},
			apiCacheNamespacePlaylistCategory: func(key string, args apiCacheArgs) {
				buildAndStore(key, apiCacheNamespacePlaylistCategory, args, newPlaylistCategoryCacheSpec(args))
			},
			apiCacheNamespaceCategoryPlaylists: func(key string, args apiCacheArgs) {
				buildAndStore(key, apiCacheNamespaceCategoryPlaylists, args, newCategoryPlaylistsCacheSpec(args))
			},
		}
	})
	return refreshBuildersByNS
}

// ---- spec 构造函数:请求路径与后台刷新共用同一份定义 ----

func newRecommendCacheSpec(args apiCacheArgs) apiCacheSpec[*jsonPlaylistTabsResponse] {
	return apiCacheSpec[*jsonPlaylistTabsResponse]{
		namespace: apiCacheNamespaceRecommend,
		build: func() *jsonPlaylistTabsResponse {
			out := buildRecommendResponse(args.Sources)
			return &out
		},
		hasContent: func(r *jsonPlaylistTabsResponse) bool {
			return playlistTabsHaveItems(r.Tabs)
		},
	}
}

func newSongListCacheSpec(contentType string, args apiCacheArgs) apiCacheSpec[*jsonSongListResponse] {
	namespace := apiCacheNamespacePlaylistDetail
	if contentType == "album" {
		namespace = apiCacheNamespaceAlbumDetail
	}
	return apiCacheSpec[*jsonSongListResponse]{
		namespace: namespace,
		build: func() *jsonSongListResponse {
			out := buildSongListDetailResponse(contentType, args.ID, args.Source)
			return &out
		},
		hasContent: func(r *jsonSongListResponse) bool { return len(r.Songs) > 0 },
	}
}

func newPlaylistCategoryCacheSpec(args apiCacheArgs) apiCacheSpec[*jsonPlaylistCategoriesResponse] {
	return apiCacheSpec[*jsonPlaylistCategoriesResponse]{
		namespace: apiCacheNamespacePlaylistCategory,
		build: func() *jsonPlaylistCategoriesResponse {
			out := buildPlaylistCategoriesResponse(args.Sources)
			return &out
		},
		hasContent: func(r *jsonPlaylistCategoriesResponse) bool {
			return playlistCategoriesHaveItems(r.Sources)
		},
	}
}

func newCategoryPlaylistsCacheSpec(args apiCacheArgs) apiCacheSpec[*jsonPlaylistListResponse] {
	return apiCacheSpec[*jsonPlaylistListResponse]{
		namespace: apiCacheNamespaceCategoryPlaylists,
		build: func() *jsonPlaylistListResponse {
			out := buildCategoryPlaylistsResponse(args.Source, args.CategoryID, args.Page)
			return &out
		},
		hasContent: func(r *jsonPlaylistListResponse) bool { return len(r.Playlists) > 0 },
	}
}

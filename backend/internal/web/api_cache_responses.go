package web

// 四个可缓存响应类型的 cacheableResponse 实现(2026-11 全库扫描收敛)。
//
// ★ Go 泛型的一个坑,值得记下来(本鱼在这里来回改了三次):
// serveWithAPICache 的泛型参数必须是**指针类型**(*jsonSongListResponse 等):
//   · decodeAPICachePayload(entry, out) 需要一个可写入的目标 → 必须是指针;
//   · SetCacheMeta 用指针接收者才能真的改到值 → 指针类型才满足接口。
// 若 T 写成值类型 + 值接收者,编译能过但 SetCacheMeta 改的是副本,
// 缓存元信息永远回填不上 —— 这是**静默失效**,比编译报错危险得多。
// 若 T 是值类型 + 指针接收者,则 T 的方法集里没有 SetCacheMeta,直接编译不过。
//
// 而 T 是指针时,`var cached T` 得到的是 nil 指针,不能直接交给 json.Unmarshal。
// 所以需要 newCacheable[T]() 先分配 —— 见下。

import "github.com/aki-riko/Melodex/backend/internal/provider/model"

// newCacheable 为指针型响应分配一个零值实例。
// 泛型无法直接 `new(T)` 后解引用成 T(那是 *T),所以用这个受限的 switch。
// 新增可缓存响应类型时必须在这里加一条 —— 漏了会在运行时 panic,
// 但 api_cache_contract_test.go 会先一步把它测出来。
func newCacheable[T cacheableResponse]() T {
	var zero T
	switch any(zero).(type) {
	case *jsonSongListResponse:
		return any(&jsonSongListResponse{}).(T)
	case *jsonPlaylistTabsResponse:
		return any(&jsonPlaylistTabsResponse{}).(T)
	case *jsonPlaylistCategoriesResponse:
		return any(&jsonPlaylistCategoriesResponse{}).(T)
	case *jsonPlaylistListResponse:
		return any(&jsonPlaylistListResponse{}).(T)
	default:
		// 未登记的类型:交给调用方的 nil 检查兜住(不会进来,除非新增类型忘了登记)。
		return zero
	}
}

func (r *jsonSongListResponse) SetCacheMeta(meta cachedResponseMeta) {
	r.cachedResponseMeta = meta
}

func (r *jsonSongListResponse) songsForWarm() []model.Track { return r.Songs }

func (r *jsonPlaylistTabsResponse) SetCacheMeta(meta cachedResponseMeta) {
	r.cachedResponseMeta = meta
}

func (r *jsonPlaylistTabsResponse) songsForWarm() []model.Track { return nil }

func (r *jsonPlaylistCategoriesResponse) SetCacheMeta(meta cachedResponseMeta) {
	r.cachedResponseMeta = meta
}

func (r *jsonPlaylistCategoriesResponse) songsForWarm() []model.Track { return nil }

func (r *jsonPlaylistListResponse) SetCacheMeta(meta cachedResponseMeta) {
	r.cachedResponseMeta = meta
}

func (r *jsonPlaylistListResponse) songsForWarm() []model.Track { return nil }

// 编译期确认四个指针类型都满足接口。
var (
	_ cacheableResponse = (*jsonSongListResponse)(nil)
	_ cacheableResponse = (*jsonPlaylistTabsResponse)(nil)
	_ cacheableResponse = (*jsonPlaylistCategoriesResponse)(nil)
	_ cacheableResponse = (*jsonPlaylistListResponse)(nil)
)

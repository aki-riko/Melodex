package web

// API 缓存收敛的契约(2026-11 全库扫描)。
//
// 背景:5 个带缓存的端点原来各写一份"查缓存→回填元信息→可能刷新→预热→
// 未命中则构建"的样板,而后台刷新又是一段 5 分支 switch 把这些复述一遍。
// 改一处缓存语义要动 10 个位置,漏一处就会出现"首查与刷新行为不一致"。
//
// 现已收敛到 apiCacheSpec + serveWithAPICache + buildAndStore。
// 这条测试锁住收敛后必须成立的四件事,防止新增端点时又长出第二份拷贝。

import (
	"reflect"
	"testing"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

// TestEveryAPICacheNamespaceHasRefreshBuilder 每个 namespace 常量都必须有
// 对应的后台刷新构造 —— 否则那个 namespace 的缓存过期后永远不会被重建,
// 用户会一直读到旧数据(而且是静默的:接口 200、数据陈旧)。
func TestEveryAPICacheNamespaceHasRefreshBuilder(t *testing.T) {
	namespaces := []string{
		apiCacheNamespaceRecommend,
		apiCacheNamespacePlaylistDetail,
		apiCacheNamespaceAlbumDetail,
		apiCacheNamespacePlaylistCategory,
		apiCacheNamespaceCategoryPlaylists,
	}
	builders := refreshBuilders()
	for _, ns := range namespaces {
		if _, ok := builders[ns]; !ok {
			t.Fatalf("namespace %q 缺少后台刷新构造 —— 缓存过期后不会被重建", ns)
		}
	}
	if len(builders) != len(namespaces) {
		t.Fatalf("刷新构造数量(%d)与 namespace 常量数量(%d)不一致:新增 namespace 时必须同步登记",
			len(builders), len(namespaces))
	}
}

// TestNewCacheableAllocatesEveryResponseType newCacheable 必须能为每种可缓存
// 响应分配实例 —— 否则 serveWithAPICache 里 decode 会解到 nil 指针上 panic。
//
// 这条是那个泛型坑的直接护栏:T 是指针类型,`var cached T` 是 nil,
// 必须先分配。新增响应类型时忘了登记,这条会红。
func TestNewCacheableAllocatesEveryResponseType(t *testing.T) {
	cases := []struct {
		name string
		got  any
		want any
	}{
		{"jsonSongListResponse", newCacheable[*jsonSongListResponse](), &jsonSongListResponse{}},
		{"jsonPlaylistTabsResponse", newCacheable[*jsonPlaylistTabsResponse](), &jsonPlaylistTabsResponse{}},
		{"jsonPlaylistCategoriesResponse", newCacheable[*jsonPlaylistCategoriesResponse](), &jsonPlaylistCategoriesResponse{}},
		{"jsonPlaylistListResponse", newCacheable[*jsonPlaylistListResponse](), &jsonPlaylistListResponse{}},
	}
	for _, tc := range cases {
		if tc.got == nil {
			t.Fatalf("newCacheable[%s] 返回 nil —— decodeAPICachePayload 会解到 nil 上", tc.name)
		}
		if reflect.TypeOf(tc.got) != reflect.TypeOf(tc.want) {
			t.Fatalf("newCacheable[%s] 类型错: got %T want %T", tc.name, tc.got, tc.want)
		}
	}
}

// TestSpecNamespaceMatchesItsBuilder 每个 spec 的 namespace 必须与它实际
// 构建的数据一致 —— 否则会把 A 接口的数据写进 B 接口的缓存 key,
// 表现为"打开歌单看到别的歌单的歌"这类串数据。
func TestSpecNamespaceMatchesItsBuilder(t *testing.T) {
	args := apiCacheArgs{Source: "qq", ID: "x1", Sources: []string{"qq"}}

	cases := []struct {
		label string
		got   string
		want  string
	}{
		{"playlist", newSongListCacheSpec("playlist", args).namespace, apiCacheNamespacePlaylistDetail},
		{"album", newSongListCacheSpec("album", args).namespace, apiCacheNamespaceAlbumDetail},
		{"recommend", newRecommendCacheSpec(args).namespace, apiCacheNamespaceRecommend},
		{"playlist_categories", newPlaylistCategoryCacheSpec(args).namespace, apiCacheNamespacePlaylistCategory},
		{"category_playlists", newCategoryPlaylistsCacheSpec(args).namespace, apiCacheNamespaceCategoryPlaylists},
	}
	for _, tc := range cases {
		if tc.got != tc.want {
			t.Fatalf("%s spec 的 namespace = %q, want %q", tc.label, tc.got, tc.want)
		}
	}
}

// TestHasContentRejectsEmptyResults 空结果必须判为"不值得缓存"。
//
// 为什么重要:把空结果写进缓存,会把"上游暂时抽风/该源暂时不支持"固化成
// 一段时间的"真的没有",用户看到的是持续空列表而不是可以重试 ——
// 这是 AGENTS.md 里明确记录的既有纪律(搜索缓存"空结果不缓存")。
func TestHasContentRejectsEmptyResults(t *testing.T) {
	args := apiCacheArgs{Source: "qq", ID: "x1", Sources: []string{"qq"}}

	// 空 → 不缓存
	if newSongListCacheSpec("playlist", args).hasContent(&jsonSongListResponse{}) {
		t.Fatal("空歌曲列表不应写缓存")
	}
	if newRecommendCacheSpec(args).hasContent(&jsonPlaylistTabsResponse{}) {
		t.Fatal("空推荐分栏不应写缓存")
	}
	if newPlaylistCategoryCacheSpec(args).hasContent(&jsonPlaylistCategoriesResponse{}) {
		t.Fatal("空分类列表不应写缓存")
	}
	if newCategoryPlaylistsCacheSpec(args).hasContent(&jsonPlaylistListResponse{}) {
		t.Fatal("空分类歌单不应写缓存")
	}

	// 非空 → 要缓存
	if !newSongListCacheSpec("playlist", args).hasContent(&jsonSongListResponse{
		Songs: []model.Track{{ID: "s1", Source: "qq"}},
	}) {
		t.Fatal("非空歌曲列表应写缓存")
	}
	if !newCategoryPlaylistsCacheSpec(args).hasContent(&jsonPlaylistListResponse{
		Playlists: []model.RemoteCollection{{ID: "p1"}},
	}) {
		t.Fatal("非空分类歌单应写缓存")
	}
}

// TestOnlySongListWarmsQuality 只有歌曲列表类响应需要预热音质。
//
// 这条防止两件事:
//   - 给不含歌曲的响应返回非 nil(会让 warmQualityCache 收到空切片,白跑);
//   - 给歌曲列表返回 nil(缓存永远不热,首播仍要现验活)。
func TestOnlySongListWarmsQuality(t *testing.T) {
	songs := []model.Track{{ID: "s1", Source: "qq"}}
	if got := (&jsonSongListResponse{Songs: songs}).songsForWarm(); len(got) != 1 {
		t.Fatalf("songList 应返回 1 首待预热, got %d", len(got))
	}
	for _, tc := range []struct {
		name string
		got  []model.Track
	}{
		{"jsonPlaylistTabsResponse", (&jsonPlaylistTabsResponse{}).songsForWarm()},
		{"jsonPlaylistCategoriesResponse", (&jsonPlaylistCategoriesResponse{}).songsForWarm()},
		{"jsonPlaylistListResponse", (&jsonPlaylistListResponse{}).songsForWarm()},
	} {
		if tc.got != nil {
			t.Fatalf("%s 不含歌曲,应返回 nil, got len=%d", tc.name, len(tc.got))
		}
	}
}

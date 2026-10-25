package web

// 分类歌单分页(首页无限滚动)的契约测试。
//
// 为什么需要:无限滚动依赖两个容易写错的约定 ——
//  ① 每一页必须用**不同的缓存 key**,否则滚到第 2 页会命中第 1 页的缓存,
//     表现为"加载更多没反应"(而且刷新后又正常,极难排查);
//  ② has_more 的语义:后端拿不到上游总数,只能按"本页是否满额"推断。
//     如果这条规则写错,要么永远滚不到底(一直以为还有),要么第 1 页就显示到底。
//
// 这两个都是纯逻辑,不需要真连上游,所以用可替换的 provider 钩子做单元测试。

import (
	"fmt"
	"testing"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

// makeCategoryPlaylists 造 n 张歌单,用于模拟某一页的返回。
func makeCategoryPlaylists(prefix string, n int) []model.RemoteCollection {
	out := make([]model.RemoteCollection, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, model.RemoteCollection{
			ID:   fmt.Sprintf("%s-%d", prefix, i),
			Name: fmt.Sprintf("%s 歌单 %d", prefix, i),
		})
	}
	return out
}

// stubCategoryFunc 用固定"总条数"模拟上游,按 page/limit 切片返回。
func stubCategoryFunc(total int) func(string) core.CategoryPlaylistsFunc {
	return func(string) core.CategoryPlaylistsFunc {
		return func(categoryID string, page, limit int) ([]model.RemoteCollection, error) {
			if page < 1 {
				page = 1
			}
			if limit <= 0 {
				limit = categoryPlaylistsPageSize
			}
			start := (page - 1) * limit
			if start >= total {
				return []model.RemoteCollection{}, nil
			}
			end := start + limit
			if end > total {
				end = total
			}
			return makeCategoryPlaylists(fmt.Sprintf("p%d", page), end-start), nil
		}
	}
}

func withCategoryStub(t *testing.T, fn func(string) core.CategoryPlaylistsFunc) {
	t.Helper()
	orig := categoryPlaylistsFunc
	categoryPlaylistsFunc = fn
	t.Cleanup(func() { categoryPlaylistsFunc = orig })
}

func TestCategoryPlaylistsPaginationFirstPageHasMore(t *testing.T) {
	// 上游共 100 张,每页 30 → 第 1 页 30 张且 has_more=true
	withCategoryStub(t, stubCategoryFunc(100))

	resp := buildCategoryPlaylistsResponse("netease", "华语", 1)
	if got := len(resp.Playlists); got != categoryPlaylistsPageSize {
		t.Fatalf("第 1 页应返回 %d 张,实际 %d", categoryPlaylistsPageSize, got)
	}
	if !resp.HasMore {
		t.Fatal("上游还有 70 张,has_more 应为 true")
	}
	if resp.Page != 1 {
		t.Fatalf("page 回显应为 1,实际 %d", resp.Page)
	}
	if resp.PageSize != categoryPlaylistsPageSize {
		t.Fatalf("page_size 回显应为 %d,实际 %d", categoryPlaylistsPageSize, resp.PageSize)
	}
}

func TestCategoryPlaylistsPaginationLastPageNoMore(t *testing.T) {
	// 上游共 65 张:第 3 页只剩 5 张 → 不满额,has_more 必须为 false
	withCategoryStub(t, stubCategoryFunc(65))

	resp := buildCategoryPlaylistsResponse("netease", "华语", 3)
	if got := len(resp.Playlists); got != 5 {
		t.Fatalf("第 3 页应返回 5 张,实际 %d", got)
	}
	if resp.HasMore {
		t.Fatal("本页不满额,说明已到底,has_more 应为 false")
	}
}

func TestCategoryPlaylistsPaginationExactBoundary(t *testing.T) {
	// 上游恰好 60 张 = 2 页整。第 2 页满额,has_more 会为 true,
	// 于是前端会再请求第 3 页并拿到空页后停止 —— 这是"按满额推断"的已知代价,
	// 这里把它固化成契约:满额就报 has_more=true,由前端用"空页"兜住。
	withCategoryStub(t, stubCategoryFunc(60))

	page2 := buildCategoryPlaylistsResponse("netease", "华语", 2)
	if len(page2.Playlists) != categoryPlaylistsPageSize {
		t.Fatalf("第 2 页应满额 %d 张,实际 %d", categoryPlaylistsPageSize, len(page2.Playlists))
	}
	if !page2.HasMore {
		t.Fatal("满额页应报 has_more=true(前端靠空页判断真正到底)")
	}

	page3 := buildCategoryPlaylistsResponse("netease", "华语", 3)
	if len(page3.Playlists) != 0 {
		t.Fatalf("第 3 页应为空,实际 %d 张", len(page3.Playlists))
	}
	if page3.HasMore {
		t.Fatal("空页 has_more 应为 false,前端据此停止")
	}
}

func TestCategoryPlaylistsPageIsolatesCacheKey(t *testing.T) {
	// 这是本测试文件最重要的一条:不同页必须落到不同缓存 key。
	// 早期把 page 写死成 1 时,前端每页都命中同一条缓存,
	// 表现为"点了加载更多但列表不长"。
	base := apiCacheArgs{Source: "netease", CategoryID: "华语", Page: 1}
	next := apiCacheArgs{Source: "netease", CategoryID: "华语", Page: 2}

	k1 := apiCacheKey(apiCacheNamespaceCategoryPlaylists, base)
	k2 := apiCacheKey(apiCacheNamespaceCategoryPlaylists, next)
	if k1 == k2 {
		t.Fatal("第 1 页与第 2 页的缓存 key 相同 —— 无限滚动会拿到重复内容")
	}

	// 同页应当稳定(缓存才有意义)
	if again := apiCacheKey(apiCacheNamespaceCategoryPlaylists, base); again != k1 {
		t.Fatal("同一页两次算出的缓存 key 不一致")
	}
}

func TestCategoryPlaylistsPageClamped(t *testing.T) {
	// page 异常值(0/负数/超大)必须被收敛,不能透传给上游去打穿它
	withCategoryStub(t, stubCategoryFunc(1000))

	for _, raw := range []int{-5, 0} {
		resp := buildCategoryPlaylistsResponse("netease", "华语", raw)
		if resp.Page != 1 {
			t.Fatalf("page=%d 应被收敛为 1,实际 %d", raw, resp.Page)
		}
	}

	// 超大 page 在限制之内时正常翻页;超过上限不应再声称 has_more
	huge := buildCategoryPlaylistsResponse("netease", "华语", categoryPlaylistsMaxPage)
	if huge.HasMore {
		t.Fatalf("已达页数上限 %d,不应继续声称还有下一页", categoryPlaylistsMaxPage)
	}
}

func TestCategoryPlaylistsUnsupportedSource(t *testing.T) {
	withCategoryStub(t, func(string) core.CategoryPlaylistsFunc { return nil })

	resp := buildCategoryPlaylistsResponse("unknown", "华语", 1)
	if resp.Error == "" {
		t.Fatal("不支持的源应返回错误说明")
	}
	if len(resp.Playlists) != 0 {
		t.Fatal("不支持的源不应返回歌单")
	}
}

package web

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

const (
	lyricOriginalArtist = "\u827e\u8fb0"
	lyricOriginalTitle  = "\u9519\u4f4d\u65f6\u7a7a"
	lyricCoverArtist    = "\u8c37\u6881\u5c0f\u7487"
)

func TestAugmentLyricSearchOriginalsPromotesInferredOriginal(t *testing.T) {
	lyricHit := model.Track{
		Source: "qq",
		ID:     "cover-mid",
		Name:   "艾辰《错位时空》",
		Artist: "谷梁小璇",
		Extra: map[string]string{
			"_rank":        "0",
			"lyric_match":  "我吹过你吹过的晚风 / 是否看过同样 风景",
			"search_match": "lyric",
		},
	}

	got := augmentLyricSearchOriginals("qq", []model.Track{lyricHit}, func(keyword string) ([]model.Track, error) {
		if keyword != "错位时空 艾辰" {
			t.Fatalf("keyword = %q, want 错位时空 艾辰", keyword)
		}
		return []model.Track{
			{Name: "艾辰《错位时空》", Artist: "谷梁小璇", ID: "cover-mid"},
			{Name: "错位时空", Artist: "洛天依", ID: "other-mid"},
			{Name: "错位时空", Artist: "艾辰", ID: "original-mid", Extra: map[string]string{"songmid": "original-mid"}},
		}, nil
	})

	if len(got) != 2 {
		t.Fatalf("len = %d, want original + lyric hit", len(got))
	}
	if got[0].Name != "错位时空" || got[0].Artist != "艾辰" || got[0].ID != "original-mid" {
		t.Fatalf("first = %+v, want inferred original", got[0])
	}
	if got[0].Extra["lyric_match"] != lyricHit.Extra["lyric_match"] {
		t.Fatalf("lyric_match = %q, want copied match", got[0].Extra["lyric_match"])
	}
	if got[0].Extra["lyric_inferred_original"] != "1" || got[0].Extra["search_match"] != "lyric" {
		t.Fatalf("extra = %+v, want inferred lyric marker", got[0].Extra)
	}
	if got[1].ID != "cover-mid" {
		t.Fatalf("second = %+v, want original lyric hit kept after inferred original", got[1])
	}
}

func TestAugmentLyricSearchOriginalsKeepsMultiSourceCandidate(t *testing.T) {
	lyricHit := model.Track{
		Source: "qq",
		ID:     "cover-mid",
		Name:   lyricOriginalArtist + "\u300a" + lyricOriginalTitle + "\u300b",
		Artist: lyricCoverArtist,
		Extra: map[string]string{
			"_rank":        "0",
			"lyric_match":  "\u6211\u5439\u8fc7\u4f60\u5439\u8fc7\u7684\u665a\u98ce",
			"search_match": "lyric",
		},
	}

	got := augmentLyricSearchOriginals("qq", []model.Track{lyricHit}, func(keyword string) ([]model.Track, error) {
		want := lyricOriginalTitle + " " + lyricOriginalArtist
		if keyword != want {
			t.Fatalf("keyword = %q, want %q", keyword, want)
		}
		return []model.Track{
			{
				Source: "qq",
				Name:   lyricOriginalTitle,
				Artist: lyricOriginalArtist,
				ID:     "003hk8xl2MJtkA",
			},
			{
				Source: "netease",
				Name:   lyricOriginalTitle,
				Artist: lyricOriginalArtist,
				ID:     "2100630469",
				Extra:  map[string]string{"song_id": "2100630469"},
			},
		}, nil
	})

	if len(got) != 3 {
		t.Fatalf("len = %d, want qq original + netease original + lyric hit", len(got))
	}
	if got[1].Source != "netease" || got[1].ID != "2100630469" {
		t.Fatalf("second = %+v, want netease original source/id preserved", got[1])
	}
	if got[1].Extra["song_id"] != "2100630469" || got[1].Extra["search_match"] != "lyric" {
		t.Fatalf("extra = %+v, want original extra plus lyric marker", got[1].Extra)
	}
}

func TestAugmentLyricSearchOriginalsSkipsWhenQuotedArtistMatchesSinger(t *testing.T) {
	hit := model.Track{
		Source: "qq",
		ID:     "original-mid",
		Name:   "艾辰《错位时空》",
		Artist: "艾辰",
	}

	called := false
	got := augmentLyricSearchOriginals("qq", []model.Track{hit}, func(keyword string) ([]model.Track, error) {
		called = true
		return nil, nil
	})
	if called {
		t.Fatal("searchFn should not be called when quoted artist already matches singer")
	}
	if len(got) != 1 || got[0].ID != "original-mid" {
		t.Fatalf("got = %+v, want original hit unchanged", got)
	}
}

// 歌词检索的"原唱补充"必须并行, 不能逐首串行。
//
// 现场事故(2026-10): 搜「牛奶面包」时 type=lyric 这一路花了 **5.22s**(同期 song 2.64s /
// album 0.43s), 前端并发发三个请求, 用户感知的就是最慢的 5s。原因是 augment 对每首带
// 《剧名》的候选都串行补一次完整多源搜索(每次 1~2s), 多个变体叠加。
func TestAugmentLyricSearchOriginalsRunsQueriesInParallel(t *testing.T) {
	hits := make([]model.Track, 0, 4)
	for i, title := range []string{"错位时空", "光年之外", "孤勇者", "晴天"} {
		hits = append(hits, model.Track{
			Source: "qq",
			ID:     fmt.Sprintf("cover-%d", i),
			Name:   fmt.Sprintf("艾辰《%s》", title),
			Artist: "谷梁小璇",
		})
	}

	const perQueryDelay = 60 * time.Millisecond
	var inflight, peak int32
	var mu sync.Mutex

	started := time.Now()
	augmentLyricSearchOriginals("qq", hits, func(keyword string) ([]model.Track, error) {
		current := atomic.AddInt32(&inflight, 1)
		mu.Lock()
		if current > peak {
			peak = current
		}
		mu.Unlock()
		time.Sleep(perQueryDelay)
		atomic.AddInt32(&inflight, -1)
		return nil, nil
	})
	elapsed := time.Since(started)

	mu.Lock()
	peakSeen := peak
	mu.Unlock()
	if peakSeen < 2 {
		t.Fatalf("并发峰值 = %d, 期望 >= 2 —— augment 搜索必须并行", peakSeen)
	}
	// 4 个查询串行至少要 240ms; 并行应接近一个 perQueryDelay。
	if elapsed > 2*perQueryDelay {
		t.Fatalf("耗时 %v, 期望接近单个查询延迟 %v(说明仍在串行)", elapsed, perQueryDelay)
	}
}

// 补搜数量必须封顶: 每多补一个就是一次完整多源搜索, 若不封顶歌词检索会被无限拖慢。
func TestAugmentLyricSearchOriginalsCapsQueryCount(t *testing.T) {
	hits := make([]model.Track, 0, 8)
	for i := 0; i < 8; i++ {
		hits = append(hits, model.Track{
			Source: "qq",
			ID:     fmt.Sprintf("cover-%d", i),
			Name:   fmt.Sprintf("艾辰《歌%d》", i),
			Artist: "谷梁小璇",
		})
	}
	var calls int32
	augmentLyricSearchOriginals("qq", hits, func(keyword string) ([]model.Track, error) {
		atomic.AddInt32(&calls, 1)
		return nil, nil
	})
	if got := atomic.LoadInt32(&calls); got > lyricAugmentMaxQueries {
		t.Fatalf("补搜次数 = %d, 超过上限 %d", got, lyricAugmentMaxQueries)
	}
}

// 同一个查询词在多首歌里重复出现时只搜一次(去重), 避免无谓的重复请求。
func TestAugmentLyricSearchOriginalsDeduplicatesQueries(t *testing.T) {
	hits := []model.Track{
		{Source: "qq", ID: "a", Name: "艾辰《错位时空》", Artist: "谷梁小璇"},
		{Source: "qq", ID: "b", Name: "艾辰《错位时空》", Artist: "谷梁小璇"},
	}
	var calls int32
	augmentLyricSearchOriginals("qq", hits, func(keyword string) ([]model.Track, error) {
		atomic.AddInt32(&calls, 1)
		return nil, nil
	})
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("补搜次数 = %d, 相同查询词应只搜 1 次", got)
	}
}
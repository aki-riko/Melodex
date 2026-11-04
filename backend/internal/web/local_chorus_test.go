package web

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"

	"github.com/aki-riko/Melodex/backend/internal/provider/bridge"
	providermodel "github.com/aki-riko/Melodex/backend/internal/provider/model"
)

// 本地库补副歌的测试。
//
// 这里的所有断言都围绕**并发纪律**(用户硬约束)展开, 并且刻意**不用耗时断言**
// (AGENTS.md 纪律: 耗时断言在 CI 上抖动)。要证明"缓存命中不重复打上游"就用
// 调用计数; 要证明"串行"就记录并发峰值。

// chorusCallCounter 记录上游被调用了几次、每次带了多少 id、以及并发峰值。
//
// 用并发峰值而不是耗时: "串行"是一个结构性事实, 峰值 1 就是串行, 与机器快慢无关。
type chorusCallCounter struct {
	mu      sync.Mutex
	calls   int
	ids     []string
	perCall [][]string
	current int
	peak    int
}

func (c *chorusCallCounter) record(request bridge.ChorusRequest) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	c.ids = append(c.ids, request.IDs...)
	c.perCall = append(c.perCall, append([]string(nil), request.IDs...))
	c.current++
	if c.current > c.peak {
		c.peak = c.current
	}
	c.current--
}

func (c *chorusCallCounter) callCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

func (c *chorusCallCounter) peakConcurrency() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.peak
}

// withChorusStub 把上游调用替换成可控的桩, 并在用例结束时还原 + 清缓存。
//
// 必须清缓存: localChorusCache 是包级全局, 上一个用例写进去的"已查过"会让
// 下一个用例断言调用次数时看到 0 次, 得到一个假绿的测试。
func withChorusStub(
	t *testing.T,
	fetch func(context.Context, bridge.ChorusRequest) (map[string]providermodel.ChorusPoint, error),
) *chorusCallCounter {
	t.Helper()
	counter := &chorusCallCounter{}
	previousFetch := localChorusFetchProvider
	previousCookie := localChorusCookieProvider
	localChorusFetchProvider = func(source string) localChorusFetchFunc {
		return func(ctx context.Context, request bridge.ChorusRequest) (map[string]providermodel.ChorusPoint, error) {
			counter.record(request)
			if fetch == nil {
				return map[string]providermodel.ChorusPoint{}, nil
			}
			return fetch(ctx, request)
		}
	}
	// 测试绝不读真实平台凭证: 置空既脱网, 也保证用例之间互不依赖登录态。
	localChorusCookieProvider = func(string) string { return "" }
	resetLocalChorusCacheForTest()
	t.Cleanup(func() {
		localChorusFetchProvider = previousFetch
		localChorusCookieProvider = previousCookie
		resetLocalChorusCacheForTest()
	})
	return counter
}

// seedDownloadRecord 往 download_records 写一条归属, 用于验证 rel_path 关联。
func seedDownloadRecord(t *testing.T, relPath, source, songID, name, artist string) {
	t.Helper()
	record := DownloadRecord{
		UserID: testUserID, RelPath: normalizeRelPath(relPath),
		Source: source, SongID: songID, Name: name, Artist: artist,
	}
	if err := db.Create(&record).Error; err != nil {
		t.Fatalf("seed download record %q: %v", relPath, err)
	}
}

func trackAt(relPath string) *localMusicTrack {
	return &localMusicTrack{RelPath: relPath, Name: "n", Extra: map[string]string{}}
}

// TestLocalChorusResolvesOriginByRelPath 锁定 rel_path -> (source, song_id) 的关联。
func TestLocalChorusResolvesOriginByRelPath(t *testing.T) {
	initCollectionDBForTest(t)
	seedDownloadRecord(t, "sub/晴天 [netease-186016].flac", "netease", "186016", "晴天", "周杰伦")
	seedDownloadRecord(t, "稻香 [kuwo-228908].mp3", "kuwo", "228908", "稻香", "周杰伦")

	origins := resolveLocalChorusOrigins([]*localMusicTrack{
		trackAt("sub/晴天 [netease-186016].flac"),
		trackAt("稻香 [kuwo-228908].mp3"),
		trackAt("没有来源的文件.mp3"),
	})
	if len(origins) != 2 {
		t.Fatalf("resolved origins = %d, want 2: %#v", len(origins), origins)
	}
	if got := origins["sub/晴天 [netease-186016].flac"]; got.Source != "netease" || got.SongID != "186016" {
		t.Fatalf("netease origin = %#v", got)
	}
	if got := origins["稻香 [kuwo-228908].mp3"]; got.Source != "kuwo" || got.SongID != "228908" {
		t.Fatalf("kuwo origin = %#v", got)
	}
}

// TestLocalChorusWritesBothExtraKeys 锁定写入前端消费的键名。
func TestLocalChorusWritesBothExtraKeys(t *testing.T) {
	initCollectionDBForTest(t)
	seedDownloadRecord(t, "a.flac", "netease", "186016", "晴天", "周杰伦")
	withChorusStub(t, func(context.Context, bridge.ChorusRequest) (map[string]providermodel.ChorusPoint, error) {
		return map[string]providermodel.ChorusPoint{
			"186016": {Start: 84498, End: 142301},
		}, nil
	})

	track := trackAt("a.flac")
	fillLocalChorusForPage([]*localMusicTrack{track})

	if track.Extra["chorus_start_ms"] != "84498" || track.Extra["chorus_end_ms"] != "142301" {
		t.Fatalf("chorus extra = %#v", track.Extra)
	}
}

// TestLocalChorusCachesAndSkipsSecondFetch 是核心断言:
// 第二次刷新必须**零上游请求**(用调用计数, 不用耗时)。
func TestLocalChorusCachesAndSkipsSecondFetch(t *testing.T) {
	initCollectionDBForTest(t)
	seedDownloadRecord(t, "a.flac", "netease", "186016", "晴天", "周杰伦")
	counter := withChorusStub(t, func(context.Context, bridge.ChorusRequest) (map[string]providermodel.ChorusPoint, error) {
		return map[string]providermodel.ChorusPoint{"186016": {Start: 84498, End: 142301}}, nil
	})

	fillLocalChorusForPage([]*localMusicTrack{trackAt("a.flac")})
	if counter.callCount() != 1 {
		t.Fatalf("first fill calls = %d, want 1", counter.callCount())
	}

	// 第二次: 缓存命中, 一个请求都不该发。
	track := trackAt("a.flac")
	fillLocalChorusForPage([]*localMusicTrack{track})
	if counter.callCount() != 1 {
		t.Fatalf("second fill calls = %d, want still 1 (cache hit)", counter.callCount())
	}
	if track.Extra["chorus_start_ms"] != "84498" {
		t.Fatalf("cached chorus not applied: %#v", track.Extra)
	}
}

// TestLocalChorusCachesNegativeResult 锁定"查过但没有"也进缓存。
// 否则每次翻页都会对没有副歌的歌重复打上游 —— 那正是用户禁止的行为。
func TestLocalChorusCachesNegativeResult(t *testing.T) {
	initCollectionDBForTest(t)
	seedDownloadRecord(t, "a.flac", "netease", "186016", "晴天", "周杰伦")
	counter := withChorusStub(t, func(context.Context, bridge.ChorusRequest) (map[string]providermodel.ChorusPoint, error) {
		return map[string]providermodel.ChorusPoint{}, nil
	})

	fillLocalChorusForPage([]*localMusicTrack{trackAt("a.flac")})
	fillLocalChorusForPage([]*localMusicTrack{trackAt("a.flac")})
	if counter.callCount() != 1 {
		t.Fatalf("negative result not cached: calls = %d, want 1", counter.callCount())
	}
}

// TestLocalChorusUpstreamFailureKeepsListing 锁定"上游失败时列表照常返回"。
func TestLocalChorusUpstreamFailureKeepsListing(t *testing.T) {
	initCollectionDBForTest(t)
	seedDownloadRecord(t, "a.flac", "netease", "186016", "晴天", "周杰伦")
	withChorusStub(t, func(context.Context, bridge.ChorusRequest) (map[string]providermodel.ChorusPoint, error) {
		return nil, context.DeadlineExceeded
	})

	track := trackAt("a.flac")
	// 不 panic 就说明降级正确; 曲目本身必须原样保留。
	fillLocalChorusForPage([]*localMusicTrack{track})
	if track.RelPath != "a.flac" || track.Name != "n" {
		t.Fatalf("track mutated on failure: %#v", track)
	}
	if _, ok := track.Extra["chorus_start_ms"]; ok {
		t.Fatalf("chorus written despite upstream failure: %#v", track.Extra)
	}
}

// TestLocalChorusSkipsUnsupportedSources 锁定 QQ 及其他源一个请求都不发。
func TestLocalChorusSkipsUnsupportedSources(t *testing.T) {
	initCollectionDBForTest(t)
	seedDownloadRecord(t, "qq.flac", "qq", "003abc", "晴天", "周杰伦")
	seedDownloadRecord(t, "soda.flac", "soda", "999", "x", "y")
	seedDownloadRecord(t, "kugou.flac", "kugou", "abc", "x", "y")
	counter := withChorusStub(t, nil)

	fillLocalChorusForPage([]*localMusicTrack{
		trackAt("qq.flac"), trackAt("soda.flac"), trackAt("kugou.flac"),
	})
	if counter.callCount() != 0 {
		t.Fatalf("unsupported sources triggered %d upstream calls, want 0", counter.callCount())
	}
}

// TestLocalChorusBatchesNeteaseIntoOneCall 锁定网易"一次批量, 不逐首"。
func TestLocalChorusBatchesNeteaseIntoOneCall(t *testing.T) {
	initCollectionDBForTest(t)
	tracks := make([]*localMusicTrack, 0, 20)
	for index := 0; index < 20; index++ {
		rel := "song" + strconv.Itoa(index) + ".flac"
		seedDownloadRecord(t, rel, "netease", strconv.Itoa(1000+index), "n", "a")
		tracks = append(tracks, trackAt(rel))
	}
	counter := withChorusStub(t, func(context.Context, bridge.ChorusRequest) (map[string]providermodel.ChorusPoint, error) {
		return map[string]providermodel.ChorusPoint{}, nil
	})

	fillLocalChorusForPage(tracks)
	if counter.callCount() != 1 {
		t.Fatalf("netease calls = %d, want exactly 1 batch", counter.callCount())
	}
	if len(counter.perCall[0]) != 20 {
		t.Fatalf("batch carried %d ids, want 20", len(counter.perCall[0]))
	}
}

// TestLocalChorusIsSequential 锁定整页补副歌不并发(用户硬约束)。
func TestLocalChorusIsSequential(t *testing.T) {
	initCollectionDBForTest(t)
	seedDownloadRecord(t, "n.flac", "netease", "186016", "晴天", "周杰伦")
	seedDownloadRecord(t, "k.flac", "kuwo", "228908", "晴天", "周杰伦")
	counter := withChorusStub(t, func(context.Context, bridge.ChorusRequest) (map[string]providermodel.ChorusPoint, error) {
		return map[string]providermodel.ChorusPoint{}, nil
	})

	fillLocalChorusForPage([]*localMusicTrack{trackAt("n.flac"), trackAt("k.flac")})
	// 两种源各一次调用, 且任何时刻都只有一个在跑。
	if counter.callCount() != 2 {
		t.Fatalf("calls = %d, want 2 (one per source)", counter.callCount())
	}
	if peak := counter.peakConcurrency(); peak > 1 {
		t.Fatalf("peak concurrency = %d, want <= 1", peak)
	}
}

// TestLocalChorusSendsKuwoHints 锁定酷我反查需要的歌名/歌手确实传给了 sidecar。
func TestLocalChorusSendsKuwoHints(t *testing.T) {
	initCollectionDBForTest(t)
	seedDownloadRecord(t, "k.flac", "kuwo", "228908", "晴天", "周杰伦")
	var captured bridge.ChorusRequest
	withChorusStub(t, func(_ context.Context, request bridge.ChorusRequest) (map[string]providermodel.ChorusPoint, error) {
		captured = request
		return map[string]providermodel.ChorusPoint{"228908": {Start: 84346, End: 142843}}, nil
	})

	track := trackAt("k.flac")
	fillLocalChorusForPage([]*localMusicTrack{track})
	if captured.KuwoHints["228908"] != "晴天 周杰伦" {
		t.Fatalf("kuwo hints = %#v", captured.KuwoHints)
	}
	if track.Extra["chorus_start_ms"] != "84346" {
		t.Fatalf("kuwo chorus not applied: %#v", track.Extra)
	}
}

// TestLocalChorusEmptyPageMakesNoRequest 锁定空页/无归属时不打上游。
func TestLocalChorusEmptyPageMakesNoRequest(t *testing.T) {
	initCollectionDBForTest(t)
	counter := withChorusStub(t, nil)
	fillLocalChorusForPage(nil)
	fillLocalChorusForPage([]*localMusicTrack{trackAt("orphan.flac")})
	if counter.callCount() != 0 {
		t.Fatalf("calls = %d, want 0", counter.callCount())
	}
}

// TestLocalChorusRejectsInvalidPoints 锁定脏点位不会写进 Extra。
func TestLocalChorusRejectsInvalidPoints(t *testing.T) {
	initCollectionDBForTest(t)
	seedDownloadRecord(t, "a.flac", "netease", "186016", "晴天", "周杰伦")
	withChorusStub(t, func(context.Context, bridge.ChorusRequest) (map[string]providermodel.ChorusPoint, error) {
		return map[string]providermodel.ChorusPoint{"186016": {Start: 0, End: 100}}, nil
	})

	track := trackAt("a.flac")
	fillLocalChorusForPage([]*localMusicTrack{track})
	if _, ok := track.Extra["chorus_start_ms"]; ok {
		t.Fatalf("invalid point written: %#v", track.Extra)
	}
}

// TestChorusFillableSourceWhitelist 直接锁定源白名单, 防止有人"顺手"放开 QQ。
func TestChorusFillableSourceWhitelist(t *testing.T) {
	fillable := map[string]bool{
		"netease": true, "kuwo": true, "qq": false, "soda": false,
		"kugou": false, "migu": false, "qianqian": false, "": false,
	}
	for source, want := range fillable {
		if got := localChorusFillableSource(source); got != want {
			t.Fatalf("localChorusFillableSource(%q) = %v, want %v", source, got, want)
		}
	}
}

// TestLocalMusicListFillsChorus 端到端: 走真实路由, 断言列表响应里带副歌。
func TestLocalMusicListFillsChorus(t *testing.T) {
	initCollectionDBForTest(t)
	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)
	if err := os.WriteFile(filepath.Join(downloadDir, "晴天.mp3"), []byte("fixture"), 0o644); err != nil {
		t.Fatalf("write audio fixture: %v", err)
	}
	seedDownloadRecord(t, "晴天.mp3", "netease", "186016", "晴天", "周杰伦")
	withChorusStub(t, func(context.Context, bridge.ChorusRequest) (map[string]providermodel.ChorusPoint, error) {
		return map[string]providermodel.ChorusPoint{"186016": {Start: 84498, End: 142301}}, nil
	})

	_, tracks := decodeLocalMusicList(t, performCollectionRequest(
		newLocalMusicTestRouter(), http.MethodGet, RoutePrefix+"/local_music", nil,
	))
	if len(tracks) != 1 {
		t.Fatalf("tracks = %d, want 1", len(tracks))
	}
	if tracks[0].Extra["chorus_start_ms"] != "84498" || tracks[0].Extra["chorus_end_ms"] != "142301" {
		t.Fatalf("list chorus extra = %#v", tracks[0].Extra)
	}
}

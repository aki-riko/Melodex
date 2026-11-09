package core

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	providermodel "github.com/aki-riko/Melodex/backend/internal/provider/model"
)

func TestProviderBridgeSearchDownloadAndLyrics(t *testing.T) {
	resetProviderBridgeStateForTest()
	defer resetProviderBridgeStateForTest()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/v1/search" {
			t.Fatalf("unexpected provider request: %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"songs": []providermodel.Track{{
				ID: "song-1", Source: "qq", Name: "晴天", Artist: "周杰伦",
				URL: "https://media.example.test/audio.flac", Ext: "flac",
				Extra: map[string]string{
					"lyric":            "[00:00.00]晴天",
					"download_headers": `{"X-Provider-Test":"applied"}`,
					"has_lossless":     "1",
				},
			}},
		})
	}))
	defer server.Close()
	t.Setenv(providerBridgeURLEnv, server.URL)

	searchFn := GetSearchFunc("qq")
	if searchFn == nil {
		t.Fatal("GetSearchFunc(qq) returned nil")
	}
	songs, err := searchFn("周杰伦 晴天")
	if err != nil {
		t.Fatal(err)
	}
	if len(songs) != 1 || songs[0].ID != "song-1" {
		t.Fatalf("unexpected songs: %#v", songs)
	}
	if songs[0].URL != "" || songs[0].Extra["download_headers"] != "" {
		t.Fatalf("public song leaked provider media data: %#v", songs[0])
	}
	if songs[0].Extra["lyric"] != "[00:00.00]晴天" {
		t.Fatalf("public song lyric = %q", songs[0].Extra["lyric"])
	}
	if songs[0].Extra["provider_lookup"] != "晴天 周杰伦" {
		t.Fatalf("provider_lookup = %q", songs[0].Extra["provider_lookup"])
	}

	downloadFn := GetDownloadFunc("qq")
	urlStr, err := downloadFn(&songs[0])
	if err != nil || urlStr != "https://media.example.test/audio.flac" {
		t.Fatalf("download URL = %q, err = %v", urlStr, err)
	}
	request, err := BuildSourceRequest(http.MethodGet, urlStr, "qq", "bytes=0-1")
	if err != nil {
		t.Fatal(err)
	}
	if request.Header.Get("X-Provider-Test") != "applied" {
		t.Fatalf("provider header = %q", request.Header.Get("X-Provider-Test"))
	}
	lyric, err := GetLyricFunc("qq")(&songs[0])
	if err != nil || lyric != "[00:00.00]晴天" {
		t.Fatalf("lyric = %q, err = %v", lyric, err)
	}
	if calls.Load() != 1 {
		t.Fatalf("provider calls = %d, want cached single call", calls.Load())
	}

	providerSongCache = sync.Map{}
	providerHeaderCache = sync.Map{}
	urlStr, err = downloadFn(&songs[0])
	if err != nil || urlStr == "" {
		t.Fatalf("download fallback URL = %q, err = %v", urlStr, err)
	}
	if calls.Load() != 2 {
		t.Fatalf("provider calls = %d, want fallback re-resolution", calls.Load())
	}
}

func TestProviderLyricsLoadsNativeNeteaseLyricAfterSearchCacheMiss(t *testing.T) {
	resetProviderBridgeStateForTest()
	defer resetProviderBridgeStateForTest()

	var lyricRequests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/search":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"songs": []providermodel.Track{{
					ID: "2110700883", Source: "netease", Name: "冬眠", Artist: "阿YueYue, 刘兆宇",
				}},
			})
		case "/v1/lyric":
			lyricRequests++
			_ = json.NewEncoder(w).Encode(map[string]string{
				"lyric": "[00:01.00]第一句\n[00:03.50]第二句",
			})
		default:
			t.Fatalf("unexpected provider request: %s", r.URL.Path)
		}
	}))
	defer server.Close()
	t.Setenv(providerBridgeURLEnv, server.URL)

	songs, err := GetSearchFunc("netease")("冬眠")
	if err != nil || len(songs) != 1 {
		t.Fatalf("search songs = %#v, err = %v", songs, err)
	}
	lyric, err := GetLyricFunc("netease")(&songs[0])
	if err != nil || lyric != "[00:01.00]第一句\n[00:03.50]第二句" {
		t.Fatalf("lyric = %q, err = %v", lyric, err)
	}
	if lyricRequests != 1 {
		t.Fatalf("provider lyric requests = %d, want 1", lyricRequests)
	}
}

// QQ 的歌词搜索必须真的按歌词片段检索(search_type=7), 普通搜歌必须仍是 0;
// 这条链路的参数一旦写错, 用户按歌词搜歌就会静默退化成"按标题搜", 只有翻唱同名噪音。
func TestQQLyricSearchSendsLyricSearchType(t *testing.T) {
	resetProviderBridgeStateForTest()
	defer resetProviderBridgeStateForTest()

	type capturedRequest struct {
		Source     string `json:"source"`
		Keyword    string `json:"keyword"`
		SearchType int    `json:"search_type"`
	}
	var captured []capturedRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body capturedRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode provider request: %v", err)
		}
		captured = append(captured, body)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"songs": []providermodel.Track{}})
	}))
	defer server.Close()
	t.Setenv(providerBridgeURLEnv, server.URL)

	lyricSearchFn := GetLyricSearchFunc("qq")
	if lyricSearchFn == nil {
		t.Fatal("GetLyricSearchFunc(qq) 返回 nil")
	}
	if _, err := lyricSearchFn("故事的小黄花"); err != nil {
		t.Fatalf("歌词搜索失败: %v", err)
	}
	if len(captured) != 1 || captured[0].SearchType != providerSearchTypeLyric {
		t.Fatalf("歌词搜索 search_type = %#v, 期望 %d", captured, providerSearchTypeLyric)
	}

	songSearchFn := GetSearchFunc("qq")
	if songSearchFn == nil {
		t.Fatal("GetSearchFunc(qq) 返回 nil")
	}
	if _, err := songSearchFn("周杰伦 晴天"); err != nil {
		t.Fatalf("普通搜索失败: %v", err)
	}
	if len(captured) != 2 || captured[1].SearchType != providerSearchTypeSong {
		t.Fatalf("普通搜索 search_type = %#v, 期望 %d", captured, providerSearchTypeSong)
	}
}

// 歌词片段检索只有 QQ 原生支持, 它必须在歌词搜索源名单里(此前因快照失效被摘掉过)。
func TestLyricSearchSourcesIncludeQQ(t *testing.T) {
	found := false
	for _, source := range GetLyricSearchSourceNames() {
		if source == "qq" {
			found = true
		}
	}
	if !found {
		t.Fatalf("歌词搜索源 %v 里缺少 qq", GetLyricSearchSourceNames())
	}
}

// QQ 的 musickey 只有 3 天寿命; sidecar 会自动续期并把新 cookie 放在 refreshed_cookie
// 里回传。这条测试锁死"续期结果必须落库", 否则下次请求又会拿过期 cookie 去打上游。
func TestSearchPersistsRefreshedCookie(t *testing.T) {
	resetProviderBridgeStateForTest()
	defer resetProviderBridgeStateForTest()

	const refreshed = "musickey=NEWKEY; keyExpiresIn=259200"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"songs":            []providermodel.Track{{ID: "song-1", Source: "qq", Name: "晴天"}},
			"refreshed_cookie": refreshed,
		})
	}))
	defer server.Close()
	t.Setenv(providerBridgeURLEnv, server.URL)

	previous := CM.Get("qq")
	defer func() {
		CM.SetAll(map[string]string{"qq": previous})
		CM.Save()
	}()
	CM.SetAll(map[string]string{"qq": "musickey=OLD"})

	if _, err := searchProviderSongsWithType("qq", "周杰伦 晴天", "musickey=OLD", providerSearchTypeSong); err != nil {
		t.Fatal(err)
	}
	if got := CM.Get("qq"); got != refreshed {
		t.Fatalf("续期后的 cookie 未落库: got %q, want %q", got, refreshed)
	}
}

// 没有续期时不得写库(否则每次搜索都会开一次 DB 事务)。
func TestSearchSkipsPersistenceWhenCookieUnchanged(t *testing.T) {
	resetProviderBridgeStateForTest()
	defer resetProviderBridgeStateForTest()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"songs": []providermodel.Track{{ID: "song-1", Source: "qq", Name: "晴天"}},
		})
	}))
	defer server.Close()
	t.Setenv(providerBridgeURLEnv, server.URL)

	previous := CM.Get("qq")
	defer func() {
		CM.SetAll(map[string]string{"qq": previous})
		CM.Save()
	}()
	CM.SetAll(map[string]string{"qq": "musickey=SAME"})

	if _, err := searchProviderSongsWithType("qq", "周杰伦 晴天", "musickey=SAME", providerSearchTypeSong); err != nil {
		t.Fatal(err)
	}
	if got := CM.Get("qq"); got != "musickey=SAME" {
		t.Fatalf("未续期时不该改动 cookie: got %q", got)
	}
}

// 歌单预热只带 ID/Source, 会让取址的兜底搜索词退化成纯数字歌曲 ID。
//
// 2026-11 真实事故: 打开几个歌单 → 连续 79 次"用数字 ID 当关键词"的网易搜索
// → 网易回 code=405 全域限流 → 「腐草为萤」播放 502, 界面只显示"音频源暂时不可用"。
//
// 这条测试锁两件事:
//  1. 没有可用取址词时必须立刻拒绝, **绝不能**退化成用 ID 去搜;
//  2. 拒绝要发生在打上游之前 —— 否则限流问题会原样复发。
func TestResolveProviderSongNeverSearchesWithSongID(t *testing.T) {
	resetProviderBridgeStateForTest()
	defer resetProviderBridgeStateForTest()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"songs": []providermodel.Track{{ID: "28188426", Source: "netease", Name: "腐草为萤"}},
		})
	}))
	defer server.Close()
	t.Setenv(providerBridgeURLEnv, server.URL)

	// 只有 ID, 没有歌名/歌手 —— 正是 collectionSongsJSON 曾经构造出来的那个形状。
	song := providermodel.Track{ID: "28188426", Source: "netease"}
	_, err := resolveProviderSong("netease", &song, "")
	if err == nil {
		t.Fatal("只有歌曲 ID 时不该解析成功")
	}
	if !strings.Contains(err.Error(), "missing provider lookup data") {
		t.Fatalf("err = %v, 期望 missing provider lookup data", err)
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("打了 %d 次上游搜索, 期望 0 次 —— 禁止用歌曲 ID 当搜索词", got)
	}
}

// 搜索链路把 sidecar 的限流错误归一化成哨兵, 上层才可能说对人话。
//
// 事故现场: sidecar 返回 400 + {"error":"netease search rate limited: 网易搜索被限流: 操作频繁"}
// 时, 它只是个普通 error → classifyPlaybackOpenError 匹配不到任何哨兵 → 落到兜底分支
// → 用户看到含糊的"音频源暂时不可用", 与实际(等一会儿就好)不符。
func TestProviderSearchErrorNormalizesRateLimitSentinel(t *testing.T) {
	resetProviderBridgeStateForTest()
	defer resetProviderBridgeStateForTest()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error": "netease search rate limited: 网易搜索被限流: 操作频繁，请稍候再试",
		})
	}))
	defer server.Close()
	t.Setenv(providerBridgeURLEnv, server.URL)

	searchFn := GetSearchFunc("netease")
	if searchFn == nil {
		t.Fatal("GetSearchFunc(netease) 返回 nil")
	}
	_, err := searchFn("腐草为萤 银临")
	if err == nil {
		t.Fatal("限流时搜索应当报错")
	}
	if !IsProviderRateLimited(err) {
		t.Fatalf("err = %v, 未被归一化成 ErrProviderRateLimited", err)
	}
	// 原始信息必须保留下来, 否则日志里再也看不出是谁限的流。
	if !strings.Contains(err.Error(), "netease") {
		t.Fatalf("归一化后丢失了原始信息: %v", err)
	}
}

// ---------------------------------------------------------------------------
// 取址候选数(providerResolveLimit)与搜索候选数(providerSearchLimit)是两条语义
// 完全不同的路径, 下面这组测试锁住它们各自的口径。
//
// 2026-11 生产事故背景: resolveProviderSong 曾经复用 providerSearchLimit()(=20),
// 于是"切一首歌"会让 sidecar 给 20 首候选**每首**都跑一遍 vkey + 音质阶梯探活,
// 再把其中 19 首的结果丢掉。生产真日志里 /music/download?stream=1 耗时
// 1.48s / 2.90s / 3.47s / **10.94s**, sidecar 侧 [qq] 搜索 limit=20 耗时
// 3.41s / 4.85s / 5.47s —— 全部花在解析那 20 首上。
// 修复把取址降到 3(可用 MUSIC_DL_PROVIDER_RESOLVE_LIMIT 调整)。
//
// 为什么必须在测试里锁死: 两个 limit 曾经是同一个常量, 以后任何人"图省事"把
// 它们合并回去, 现场不会报错, 只会安静地退回"切歌等十秒"; 反过来, 谁把搜索
// 侧也顺手改成 3, 前端搜索列表会从 20 首静默缩到 3 首, 同样没有任何报错。
// 两条都是无异常、无日志的静默回归, 只能靠这里的断言拦住。
// ---------------------------------------------------------------------------

// providerResolveLimit 的取值契约: 默认 3、受 MUSIC_DL_PROVIDER_RESOLVE_LIMIT
// 控制、上限钳到 20, 且**永远不会**返回 <=0。
//
// 最后那条(永不为 0/负)比"小于 1 钳到 1"更贴近真实风险: bridge.SearchRequest 的
// Limit 带 `json:"limit,omitempty"`, 一旦算出 0 就会被序列化层整个吞掉, sidecar
// 收不到 limit 就退回它自己的默认值(20) —— 即"配置成 0 想更省"反而变回最慢的那档,
// 而且日志上完全看不出异常。所以这里按实际可观测行为断言:
// 非法/非正的环境变量一律回退到默认值 3(底层 intEnv 对 n<=0 直接 fallback,
// providerResolveLimit 里那个 limit<1 分支是纯防御, 不靠它兜底)。
func TestProviderResolveLimitDefaultsAndClamps(t *testing.T) {
	cases := []struct {
		raw  string
		want int
		why  string
	}{
		{"", providerResolveLimitDefault, "未配置时必须用自己的默认值 3, 而不是搜索页的 20"},
		{"1", 1, "允许压到 1(取址本来就只要那一首)"},
		{"3", 3, "显式写成默认值"},
		{"7", 7, "1..20 之间的值原样生效"},
		{"20", providerResolveLimitMax, "等于上限时不动"},
		{"21", providerResolveLimitMax, "超过上限钳到 20, 否则用户能把搜索页的量级原样搬回来"},
		{"9999", providerResolveLimitMax, "离谱值同样钳到 20"},
		{"0", providerResolveLimitDefault, "0 会被 omitempty 吞掉并让 sidecar 退回默认 20, 必须回退默认值"},
		{"-4", providerResolveLimitDefault, "负数同理, 绝不能把 <=0 的 limit 发给 sidecar"},
		{"abc", providerResolveLimitDefault, "非法值不得崩溃, 更不能变成 0"},
		{" 5 ", 5, "两端空白必须被容忍(env 常带空格)"},
	}
	for _, tc := range cases {
		t.Run("raw="+tc.raw, func(t *testing.T) {
			t.Setenv(providerResolveLimitEnv, tc.raw)
			got := providerResolveLimit()
			if got != tc.want {
				t.Fatalf("providerResolveLimit() = %d, 期望 %d —— %s", got, tc.want, tc.why)
			}
			if got < 1 {
				t.Fatalf("取址候选数 = %d, 必须是正整数: limit<=0 会被 omitempty 吞掉, 反而让 sidecar 用回 20", got)
			}
		})
	}
}

// 搜索列表路径必须仍然按 20 首候选请求 —— 这是产品要求(用户要看到一页候选),
// 不能被"切歌提速"顺带削掉, 也不能被取址侧的配置污染。
func TestProviderSearchLimitStaysAtTwenty(t *testing.T) {
	t.Setenv(providerSearchLimitEnv, "")
	if providerSearchLimitDefault != 20 {
		t.Fatalf("providerSearchLimitDefault = %d, 期望 20", providerSearchLimitDefault)
	}
	if got := providerSearchLimit(); got != 20 {
		t.Fatalf("providerSearchLimit() 默认 = %d, 期望 20 —— 搜索页必须仍是 20 首", got)
	}

	// 核心防误伤断言: 把"取址"候选数调小, 不得连带影响"搜索"候选数。
	// 两条路径共用过同一个 env(MUSIC_DL_PROVIDER_SEARCH_LIMIT), 这条断言就是
	// 防止有人再次把两个 limit 合并回去。
	for _, resolveRaw := range []string{"1", "3", "20"} {
		t.Setenv(providerResolveLimitEnv, resolveRaw)
		if got := providerSearchLimit(); got != 20 {
			t.Fatalf("resolve limit = %q 时 providerSearchLimit() = %d, 期望 20 —— 取址配置污染了搜索路径", resolveRaw, got)
		}
	}

	// 搜索侧自己的 env 仍独立生效(既有能力不能被这次改动削掉)。
	t.Setenv(providerSearchLimitEnv, "30")
	if got := providerSearchLimit(); got != 30 {
		t.Fatalf("providerSearchLimit() = %d, 期望 30", got)
	}
	t.Setenv(providerSearchLimitEnv, "1000")
	if got := providerSearchLimit(); got != providerSearchLimitMax {
		t.Fatalf("providerSearchLimit() = %d, 期望钳到 %d", got, providerSearchLimitMax)
	}
}

// 上面的单元测试只证明"计算出来的数对"; 这条走真实 HTTP 链路, 证明**发出去的
// limit 确实变了**: 搜索请求 limit=20, 取址请求 limit=3。
//
// 为什么需要这一层: providerResolveLimit() 算得再对, 只要 resolveProviderSong
// 里那一行仍旧写 providerSearchLimit(), 生产上就一点没变快(这正是改动前的状态)。
// 只断言函数返回值等于自证, 拦住回归的是这一条。
func TestSearchSendsTwentyWhileResolveSendsThree(t *testing.T) {
	resetProviderBridgeStateForTest()
	defer resetProviderBridgeStateForTest()

	type capturedRequest struct {
		Keyword string `json:"keyword"`
		Limit   int    `json:"limit"`
	}
	var mu sync.Mutex
	var requests []capturedRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body capturedRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode provider request: %v", err)
		}
		mu.Lock()
		requests = append(requests, body)
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"songs": []providermodel.Track{{
				ID: "song-1", Source: "qq", Name: "晴天", Artist: "周杰伦",
				URL: "https://media.example.test/audio.flac", Ext: "flac",
			}},
		})
	}))
	defer server.Close()
	t.Setenv(providerBridgeURLEnv, server.URL)
	t.Setenv(providerResolveLimitEnv, "") // 走默认 3

	// ① 搜索列表路径: 必须仍按 20 首请求。
	searchFn := GetSearchFunc("qq")
	if searchFn == nil {
		t.Fatal("GetSearchFunc(qq) 返回 nil")
	}
	if _, err := searchFn("周杰伦 晴天"); err != nil {
		t.Fatalf("搜索失败: %v", err)
	}

	// ② 取址路径: 清掉刚写入的歌曲缓存, 确保真的再打一次 sidecar。
	providerSongCache = sync.Map{}
	track := providermodel.Track{ID: "song-1", Source: "qq", Name: "晴天", Artist: "周杰伦"}
	if _, err := resolveProviderSong("qq", &track, ""); err != nil {
		t.Fatalf("取址失败: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 2 {
		t.Fatalf("provider 请求次数 = %d, 期望 2(搜索 1 + 取址 1): %#v", len(requests), requests)
	}
	if requests[0].Limit != providerSearchLimitDefault {
		t.Fatalf("搜索请求 limit = %d, 期望 %d —— 搜索页候选数被改动波及了", requests[0].Limit, providerSearchLimitDefault)
	}
	if requests[1].Limit != providerResolveLimitDefault {
		t.Fatalf("取址请求 limit = %d, 期望 %d —— 取址仍在按搜索页的量级打上游, 切歌不会变快", requests[1].Limit, providerResolveLimitDefault)
	}
}

// 候选数从 20 降到 3 之后, resolveProviderSong 里既有的
// "按 ID 精确命中 → 否则按相似度兜底(阈值 0.75)"必须仍然成立。
//
// 为什么单独测这个: 提速的风险不在"快", 而在"为了快把兜底逻辑弄坏了却没人发现"。
// 三种候选形态各锁一条:
//  1. 目标 ID 排在第 3 位(译名/多版本常见的排序) → 必须靠 ID 命中, 不能因为
//     相似度更高就返回前面的候选;
//  2. 候选里没有目标 ID, 但有明显同名的另一版 → 相似度兜底应捡起它;
//  3. 3 个候选都不像(真·付费/下架) → 仍返回 ErrProviderPaidOnly, 而不是
//     随便塞一首歌给用户播。
func TestResolveProviderSongFallbackSurvivesSmallCandidateLimit(t *testing.T) {
	resolveAgainst := func(t *testing.T, candidates []providermodel.Track, target providermodel.Track) (providermodel.Track, error) {
		t.Helper()
		resetProviderBridgeStateForTest()
		defer resetProviderBridgeStateForTest()

		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"songs": candidates})
		}))
		defer server.Close()
		t.Setenv(providerBridgeURLEnv, server.URL)
		return resolveProviderSong("qq", &target, "")
	}

	t.Run("目标 ID 排在第 3 位仍按 ID 命中", func(t *testing.T) {
		candidates := []providermodel.Track{
			{ID: "other-1", Source: "qq", Name: "晴天", Artist: "周杰伦"},
			{ID: "other-2", Source: "qq", Name: "晴天", Artist: "周杰伦"},
			{ID: "target-id", Source: "qq", Name: "晴天 (电视剧原声版)", Artist: "周杰伦"},
		}
		target := providermodel.Track{ID: "target-id", Source: "qq", Name: "晴天", Artist: "周杰伦"}
		resolved, err := resolveAgainst(t, candidates, target)
		if err != nil {
			t.Fatalf("按 ID 命中失败: %v", err)
		}
		if resolved.ID != "target-id" {
			t.Fatalf("返回 ID = %q, 期望 target-id —— ID 精确命中必须优先于相似度, 不能返回相似度更高的 other-1", resolved.ID)
		}
	})

	t.Run("无 ID 命中时按相似度兜底", func(t *testing.T) {
		candidates := []providermodel.Track{
			{ID: "other-1", Source: "qq", Name: "孤勇者", Artist: "陈奕迅"},
			{ID: "other-2", Source: "qq", Name: "晴天", Artist: "周杰伦"},
		}
		target := providermodel.Track{ID: "target-id", Source: "qq", Name: "晴天", Artist: "周杰伦"}
		resolved, err := resolveAgainst(t, candidates, target)
		if err != nil {
			t.Fatalf("相似度兜底失败: %v", err)
		}
		if resolved.ID != "other-2" {
			t.Fatalf("返回 ID = %q, 期望 other-2 —— 相似度兜底(阈值 0.75)必须仍能捡起同名同艺人的候选", resolved.ID)
		}
	})

	t.Run("候选全不相似时仍报付费或不可用", func(t *testing.T) {
		candidates := []providermodel.Track{
			{ID: "other-1", Source: "qq", Name: "孤勇者", Artist: "陈奕迅"},
			{ID: "other-2", Source: "qq", Name: "七里香", Artist: "周杰伦"},
			{ID: "other-3", Source: "qq", Name: "江南", Artist: "林俊杰"},
		}
		target := providermodel.Track{ID: "target-id", Source: "qq", Name: "晴天", Artist: "周杰伦"}
		_, err := resolveAgainst(t, candidates, target)
		if err == nil {
			t.Fatal("候选全不相似时必须报错, 不能随便塞一首歌给用户播")
		}
		if !IsProviderPaidOnly(err) {
			t.Fatalf("err = %v, 期望 ErrProviderPaidOnly(重试无用, 该换源而不是等)", err)
		}
	})
}

func resetProviderBridgeStateForTest() {	providerBridgeClientMu.Lock()
	providerBridgeClientURL = ""
	providerBridgeClient = nil
	providerBridgeClientMu.Unlock()
	providerSongCache = sync.Map{}
	providerHeaderCache = sync.Map{}
}

// 两段式取址的核心契约: 快路径(limit=3)没拿到**精确 ID 命中**时, 必须升级到
// 完整候选数(limit=20)再跑一遍, 而**不能**只在 3 首里做相似度兜底就返回。
//
// 为什么这条必须锁住(2026-11): 这是"切歌慢"修复里唯一能造成静默行为回归的地方。
// 只降候选数会让兜底池一起缩水 —— 目标曲不在前 3 名时会退化成"在前 3 名里挑个像的",
// 用户听到的是同名的 live/翻唱版本、或歌词拿到别人的, 且全程不报错。升级重跑保证了
// 最终结果与改动前逐字等价, 快路径只是省掉常见情形里的白工。
func TestResolveProviderSongEscalatesToFullCandidatesWhenFastPathMisses(t *testing.T) {
	resetProviderBridgeStateForTest()
	defer resetProviderBridgeStateForTest()

	// 快路径返回 3 首里没有目标 ID; 完整路径第 5 首才是目标。
	fastCandidates := []providermodel.Track{
		{ID: "other-1", Source: "qq", Name: "晴天", Artist: "周杰伦"},
		{ID: "other-2", Source: "qq", Name: "晴天", Artist: "周杰伦"},
		{ID: "other-3", Source: "qq", Name: "晴天", Artist: "周杰伦"},
	}
	fullCandidates := append([]providermodel.Track{
		{ID: "other-4", Source: "qq", Name: "晴天 (Live)", Artist: "周杰伦"},
	}, append([]providermodel.Track{
		{ID: "target-id", Source: "qq", Name: "晴天", Artist: "周杰伦", URL: "https://media.example.test/target.flac"},
	}, fastCandidates...)...)

	var mu sync.Mutex
	var limits []int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Limit int `json:"limit"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode provider request: %v", err)
		}
		mu.Lock()
		limits = append(limits, body.Limit)
		mu.Unlock()
		songs := fastCandidates
		if body.Limit > len(fastCandidates) {
			songs = fullCandidates
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"songs": songs})
	}))
	defer server.Close()
	t.Setenv(providerBridgeURLEnv, server.URL)
	t.Setenv(providerResolveLimitEnv, "") // 默认 3
	t.Setenv(providerSearchLimitEnv, "")  // 默认 20

	target := providermodel.Track{ID: "target-id", Source: "qq", Name: "晴天", Artist: "周杰伦"}
	resolved, err := resolveProviderSong("qq", &target, "")
	if err != nil {
		t.Fatalf("取址失败: %v", err)
	}
	if resolved.ID != "target-id" {
		t.Fatalf("返回 ID = %q, 期望 target-id —— 快路径未命中时必须升级到完整候选数再找, "+
			"不能只在前 3 首里按相似度挑(那会播成同名的其它版本)", resolved.ID)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(limits) != 2 {
		t.Fatalf("provider 请求次数 = %d(limits=%v), 期望 2: 先快路径 3 首, 未命中再完整 20 首", len(limits), limits)
	}
	if limits[0] != providerResolveLimitDefault {
		t.Fatalf("第一次请求 limit = %d, 期望快路径 %d", limits[0], providerResolveLimitDefault)
	}
	if limits[1] != providerSearchLimitDefault {
		t.Fatalf("第二次请求 limit = %d, 期望完整候选数 %d —— 未升级就等于兜底池被砍, 会静默播错版本",
			limits[1], providerSearchLimitDefault)
	}
}

// 快路径**精确命中**时不得再打一次完整搜索(否则省不下任何开销, 这个修复就没意义了)。
func TestResolveProviderSongFastPathHitSkipsFullSearch(t *testing.T) {
	resetProviderBridgeStateForTest()
	defer resetProviderBridgeStateForTest()

	var mu sync.Mutex
	var limits []int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Limit int `json:"limit"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		limits = append(limits, body.Limit)
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"songs": []providermodel.Track{
			{ID: "target-id", Source: "qq", Name: "晴天", Artist: "周杰伦", URL: "https://media.example.test/a.flac"},
		}})
	}))
	defer server.Close()
	t.Setenv(providerBridgeURLEnv, server.URL)
	t.Setenv(providerResolveLimitEnv, "")
	t.Setenv(providerSearchLimitEnv, "")

	target := providermodel.Track{ID: "target-id", Source: "qq", Name: "晴天", Artist: "周杰伦"}
	resolved, err := resolveProviderSong("qq", &target, "")
	if err != nil {
		t.Fatalf("取址失败: %v", err)
	}
	if resolved.ID != "target-id" {
		t.Fatalf("返回 ID = %q, 期望 target-id", resolved.ID)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(limits) != 1 {
		t.Fatalf("provider 请求次数 = %d(limits=%v), 期望 1 —— 快路径已精确命中就不该再打完整搜索",
			len(limits), limits)
	}
	if limits[0] != providerResolveLimitDefault {
		t.Fatalf("请求 limit = %d, 期望 %d", limits[0], providerResolveLimitDefault)
	}
}

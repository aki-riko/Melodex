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

func resetProviderBridgeStateForTest() {	providerBridgeClientMu.Lock()
	providerBridgeClientURL = ""
	providerBridgeClient = nil
	providerBridgeClientMu.Unlock()
	providerSongCache = sync.Map{}
	providerHeaderCache = sync.Map{}
}

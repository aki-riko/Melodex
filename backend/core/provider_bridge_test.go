package core

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

func resetProviderBridgeStateForTest() {
	providerBridgeClientMu.Lock()
	providerBridgeClientURL = ""
	providerBridgeClient = nil
	providerBridgeClientMu.Unlock()
	providerSongCache = sync.Map{}
	providerHeaderCache = sync.Map{}
}

package core

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestQQProviderPayloadContract 用真实抓取的 provider 响应锁定 provider → Go 的字段契约。
//
// fixture (testdata/qq_provider_search.json) 是 provider_bridge 原生 QQ 实现真实返回的
// /v1/search 响应体,抓自 NAS 生产环境的实际请求,仅把短时效的 vkey/guid 查询值擦成
// REDACTED。载荷键名、可播地址、下载请求头、歌词、provider_lookup 任一环节漂移都会在
// 这里失败,而不是在生产上静默变成空字段(QQ 源之前就是这样整条失效且毫无声响的)。
func TestQQProviderPayloadContract(t *testing.T) {
	resetProviderBridgeStateForTest()
	defer resetProviderBridgeStateForTest()

	raw, err := os.ReadFile(filepath.Join("testdata", "qq_provider_search.json"))
	if err != nil {
		t.Fatalf("读取 QQ 载荷 fixture 失败: %v", err)
	}
	var fixture struct {
		Songs []map[string]json.RawMessage `json:"songs"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("fixture 不是合法 JSON: %v", err)
	}
	if len(fixture.Songs) == 0 {
		t.Fatal("fixture 里没有歌曲")
	}

	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPost || r.URL.Path != "/v1/search" {
			t.Errorf("unexpected provider request: %s %s", r.Method, r.URL.Path)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(raw)
	}))
	defer server.Close()
	t.Setenv(providerBridgeURLEnv, server.URL)

	searchFn := GetSearchFunc("qq")
	if searchFn == nil {
		t.Fatal("GetSearchFunc(qq) 返回 nil")
	}
	songs, err := searchFn("晴天")
	if err != nil {
		t.Fatalf("QQ 搜索结果映射失败: %v", err)
	}
	if len(songs) != len(fixture.Songs) {
		t.Fatalf("映射后歌曲数 = %d, fixture = %d", len(songs), len(fixture.Songs))
	}
	if requests != 1 {
		t.Fatalf("provider 请求次数 = %d, 期望 1", requests)
	}

	withCover, withLyric := 0, 0
	for index, song := range songs {
		if song.Source != "qq" {
			t.Fatalf("第 %d 首 source = %q", index, song.Source)
		}
		if song.ID == "" || song.Name == "" || song.Artist == "" || song.Ext == "" {
			t.Fatalf("第 %d 首关键字段缺失: %#v", index, song)
		}
		if song.Duration <= 0 {
			t.Fatalf("第 %d 首 duration = %d", index, song.Duration)
		}
		if song.Bitrate <= 0 {
			// O801 档 QQ 不返回体积, 应当回退到标称码率而不是 0。
			t.Fatalf("第 %d 首 bitrate = 0, 标称码率回退失效", index)
		}
		// 公开歌曲不得泄露播放地址与下载头, 二者只在解析时按需取回。
		if song.URL != "" || song.Extra["download_headers"] != "" {
			t.Fatalf("第 %d 首泄露了 provider 媒体数据: %#v", index, song)
		}
		if song.Extra["provider_lookup"] == "" {
			t.Fatalf("第 %d 首缺少 provider_lookup", index)
		}
		if song.Extra["provider"] != "melodex-native" {
			t.Fatalf("第 %d 首 provider = %q, 期望走自有实现", index, song.Extra["provider"])
		}
		if song.Cover != "" {
			withCover++
		}
		if song.Extra["lyric"] != "" {
			withLyric++
		}
	}
	if withCover == 0 {
		t.Fatal("fixture 中没有任何带封面的歌曲")
	}
	if withLyric == 0 {
		t.Fatal("fixture 中没有任何带歌词的歌曲")
	}

	// 播放地址按需解析: 命中搜索缓存, 不应该再打 provider。
	downloadFn := GetDownloadFunc("qq")
	if downloadFn == nil {
		t.Fatal("GetDownloadFunc(qq) 返回 nil")
	}
	urlStr, err := downloadFn(&songs[0])
	if err != nil {
		t.Fatalf("解析 QQ 播放地址失败: %v", err)
	}
	if !strings.HasPrefix(urlStr, "https://ws.stream.qqmusic.qq.com/") {
		t.Fatalf("播放地址 = %q, 期望 QQ 媒体域", urlStr)
	}
	if requests != 1 {
		t.Fatalf("解析地址不该新增 provider 请求, 当前 %d", requests)
	}

	// 下载请求头必须真正生效: QQ CDN 需要 Referer/UA。
	// 注意 BuildSourceRequest 的顺序是"先应用 provider 头, 再写源档", 所以对 QQ 而言生效的
	// 是 sourceRequestProfiles 里的 Referer/UA, 载荷里的 download_headers 只作兜底。
	request, err := BuildSourceRequest(http.MethodGet, urlStr, "qq", "bytes=0-1")
	if err != nil {
		t.Fatal(err)
	}
	if got := request.Header.Get("Referer"); !strings.Contains(got, "y.qq.com") {
		t.Fatalf("下载请求 Referer = %q, 期望 QQ 域", got)
	}
	if got := request.Header.Get("User-Agent"); got == "" {
		t.Fatal("下载请求缺少 User-Agent")
	}
	if got := request.Header.Get("Range"); got != "bytes=0-1" {
		t.Fatalf("Range = %q", got)
	}

	lyricFn := GetLyricFunc("qq")
	if lyricFn == nil {
		t.Fatal("GetLyricFunc(qq) 返回 nil")
	}
	lyric, err := lyricFn(&songs[0])
	if err != nil {
		t.Fatalf("取 QQ 歌词失败: %v", err)
	}
	if !strings.Contains(lyric, "[00:") {
		head := lyric
		if len(head) > 80 {
			head = head[:80]
		}
		t.Fatalf("QQ 歌词不是 LRC 形状: %q", head)
	}
}

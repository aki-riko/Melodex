package core

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestNeteaseLyricSearchSendsLyricType 锁定: 走歌词搜索入口时, 网易必须带上 search_type=7。
//
// 背景: 这条路径此前只对 QQ 开(其余源显式降级成"按标题/歌手兜底"), 结果是搜歌词片段在
// 网易上得到一堆同名垃圾; 而 QQ 会员凭证一失效, 歌词片段搜索就整体不可用。
// 网易侧现在由 provider_bridge/netease_source.py 接管(原生 type=1006 歌词检索),
// 前提是 Go 侧真的把 search_type=7 传下去 —— 这个测试就是防它被改回去。
func TestNeteaseLyricSearchSendsLyricType(t *testing.T) {
	resetProviderBridgeStateForTest()
	defer resetProviderBridgeStateForTest()

	var bodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/search" {
			t.Errorf("unexpected provider request: %s %s", r.Method, r.URL.Path)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("provider 请求体不是 JSON: %v", err)
			body = map[string]any{}
		}
		bodies = append(bodies, body)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"songs":[]}`))
	}))
	defer server.Close()
	t.Setenv(providerBridgeURLEnv, server.URL)

	lyricSearchFn := GetLyricSearchFunc("netease")
	if lyricSearchFn == nil {
		t.Fatal("GetLyricSearchFunc(netease) 返回 nil")
	}
	if _, err := lyricSearchFn("都 是勇敢的"); err != nil {
		t.Fatalf("网易歌词片段搜索失败: %v", err)
	}
	if len(bodies) != 1 {
		t.Fatalf("provider 请求次数 = %d, 期望 1", len(bodies))
	}
	if got := bodies[0]["search_type"]; got != float64(providerSearchTypeLyric) {
		t.Fatalf("网易歌词搜索 search_type = %v, 期望 %d", got, providerSearchTypeLyric)
	}
	if got := bodies[0]["source"]; got != "netease" {
		t.Fatalf("网易歌词搜索 source = %v", got)
	}

	// 普通搜歌必须保持原样: 不带 search_type(结构体上是 omitempty), 否则会整体偏到歌词检索。
	if _, err := GetSearchFunc("netease")("晴天"); err != nil {
		t.Fatalf("网易普通搜索失败: %v", err)
	}
	if len(bodies) != 2 {
		t.Fatalf("provider 请求次数 = %d, 期望 2", len(bodies))
	}
	if _, exists := bodies[1]["search_type"]; exists {
		t.Fatalf("普通搜歌不该带 search_type, 实际 %v", bodies[1]["search_type"])
	}
}

// TestLyricSearchFallbackStaysForSourcesWithoutLyricAPI 锁定 kuwo/migu 仍是标题/歌手兜底
// (快照没有歌词检索能力), 免得以后顺手把它们也接成歌词检索却没人验证过。
func TestLyricSearchFallbackStaysForSourcesWithoutLyricAPI(t *testing.T) {
	resetProviderBridgeStateForTest()
	defer resetProviderBridgeStateForTest()

	var bodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"songs":[]}`))
	}))
	defer server.Close()
	t.Setenv(providerBridgeURLEnv, server.URL)

	for _, source := range []string{"kuwo", "migu"} {
		fn := GetLyricSearchFunc(source)
		if fn == nil {
			t.Fatalf("GetLyricSearchFunc(%s) 返回 nil", source)
		}
		if _, err := fn("都 是勇敢的"); err != nil {
			t.Fatalf("%s 歌词搜索失败: %v", source, err)
		}
	}
	for index, body := range bodies {
		if _, exists := body["search_type"]; exists {
			t.Fatalf("第 %d 次请求带了 search_type, %s 应仍是兜底搜索", index, body["source"])
		}
	}
}

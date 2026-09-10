package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// TestConcurrentKeywordSearchReturnsWhenPrimarySourcesFinish 锁住 2026-09 这次提速的关键行为。
//
// 背景(实测 limit=20): QQ 1.7s(慢时 8.4s)、网易原生 ~1s, 而 qianqian 18.7s / kugou 25.2s /
// kuwo 83.7s / migu 114.9s。旧实现"一律等到预算耗尽"—— 60s 预算下每次搜索都实打实等满一分钟,
// 而慢源本来也回不来。现在改成: 主力源(qq/netease)齐了就立刻返回, 慢源赶上才算。
// 这个测试让慢源挂住 10s, 断言整次搜索仍在 3s 内返回, 且慢源的结果不会混进来。
func TestConcurrentKeywordSearchReturnsWhenPrimarySourcesFinish(t *testing.T) {
	var mu sync.Mutex
	sawSlowSource := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Source string `json:"source"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Source == "kugou" {
			mu.Lock()
			sawSlowSource = true
			mu.Unlock()
			time.Sleep(10 * time.Second)
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		tracks := []map[string]any{}
		if body.Source == "qq" || body.Source == "netease" {
			tracks = append(tracks, map[string]any{
				"id": body.Source + "-1", "name": "晴天", "artist": "周杰伦", "source": body.Source,
				"url": "https://example.invalid/a.mp3", "ext": "mp3", "duration": 269, "size": 1024,
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"songs": tracks})
	}))
	defer server.Close()
	// 每个测试用独立的 httptest URL, provider 客户端按 URL 缓存, 不需要额外重置状态。
	t.Setenv("MUSIC_DL_PROVIDER_URL", server.URL)

	start := time.Now()
	songs, _ := concurrentKeywordSearch("周杰伦 晴天", "song", []string{"qq", "netease", "kugou"})
	elapsed := time.Since(start)

	if elapsed >= 3*time.Second {
		t.Fatalf("主力源齐了却等了 %s, 说明还在等慢源", elapsed)
	}
	if len(songs) != 2 {
		t.Fatalf("songs = %d, want 2 (只应有 qq 与 netease 的结果)", len(songs))
	}
	sources := map[string]bool{}
	for _, song := range songs {
		sources[song.Source] = true
	}
	if !sources["qq"] || !sources["netease"] {
		t.Fatalf("主力源结果缺失: %#v", sources)
	}
	if sources["kugou"] {
		t.Fatal("慢源还没返回, 不该有它的结果")
	}

	// 慢源的 goroutine 仍在跑(结果会被丢弃), 这里确认它确实被发起过 —— 否则测试可能是在
	// "压根没请求慢源"的情况下通过, 那样就测不到真实行为。
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		seen := sawSlowSource
		mu.Unlock()
		if seen {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("慢源请求没有发出, 测试前提不成立")
}

// TestConcurrentKeywordSearchWaitsForAllSourcesWithoutPrimarySources 用户把主力源都排除时
// (例如只选酷我+咪咕)没有"早退"依据, 必须等齐所选源(仍在预算内), 不能第一个返回就收工。
func TestConcurrentKeywordSearchWaitsForAllSourcesWithoutPrimarySources(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Source string `json:"source"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		// 第二个源故意慢一点, 用来区分"等齐"与"第一个就返回"。
		if body.Source == "qianqian" {
			time.Sleep(400 * time.Millisecond)
		}
		tracks := []map[string]any{{
			"id": body.Source + "-1", "name": "晴天", "artist": "周杰伦", "source": body.Source,
			"url": "https://example.invalid/a.mp3", "ext": "mp3", "duration": 269, "size": 1024,
		}}
		_ = json.NewEncoder(w).Encode(map[string]any{"songs": tracks})
	}))
	defer server.Close()
	t.Setenv("MUSIC_DL_PROVIDER_URL", server.URL)
	t.Setenv("MUSIC_DL_SEARCH_SOURCE_BUDGET", "10s")

	songs, _ := concurrentKeywordSearch("晴天", "song", []string{"kuwo", "qianqian"})
	if len(songs) != 2 {
		t.Fatalf("songs = %d, want 2 (两个源都必须等到)", len(songs))
	}
}

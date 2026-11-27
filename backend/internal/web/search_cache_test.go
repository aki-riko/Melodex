package web

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/gin-gonic/gin"
)

func TestSearchCacheKeyOrderInsensitive(t *testing.T) {
	k1 := searchCacheKey("song", "晴天", "", []string{"qq", "netease"})
	k2 := searchCacheKey("song", "晴天", "", []string{"netease", "qq"})
	if k1 != k2 {
		t.Fatal("source order should not change cache key")
	}
	k3 := searchCacheKey("song", "晴天", "周杰伦", []string{"qq", "netease"})
	if k1 == k3 {
		t.Fatal("exactArtist should change cache key")
	}
	k4 := searchCacheKey("playlist", "晴天", "", []string{"qq", "netease"})
	if k1 == k4 {
		t.Fatal("type should change cache key")
	}
}

func TestSearchCacheKeySeparatesNativeLyricSearchFromLegacy(t *testing.T) {
	keyword := "我吹过你吹过的晚风"
	sources := []string{"qq"}
	got := searchCacheKey("lyric", keyword, "", sources)
	legacy := legacySearchCacheKeyForTest("lyric", keyword, "", sources)
	if got == legacy {
		t.Fatal("lyric search cache key reused the legacy song-candidate implementation key")
	}
}

func TestSearchBackgroundConcurrencyHonorsEnv(t *testing.T) {
	t.Setenv("MUSIC_DL_SEARCH_BACKGROUND_CONCURRENCY", "3")
	if got := searchBackgroundConcurrency(); got != 3 {
		t.Fatalf("background concurrency = %d, want 3", got)
	}
	t.Setenv("MUSIC_DL_SEARCH_BACKGROUND_CONCURRENCY", "not-a-number")
	if got := searchBackgroundConcurrency(); got != searchBackgroundConcurrencyDefault {
		t.Fatalf("invalid background concurrency = %d, want default %d", got, searchBackgroundConcurrencyDefault)
	}
}

func legacySearchCacheKeyForTest(searchType, keyword, exactArtist string, sources []string) string {
	s := append([]string(nil), sources...)
	sort.Strings(s)
	raw := strings.Join([]string{
		strings.ToLower(strings.TrimSpace(searchType)),
		strings.ToLower(strings.TrimSpace(keyword)),
		strings.ToLower(strings.TrimSpace(exactArtist)),
		strings.Join(s, ","),
	}, "\x00")
	sum := sha1.Sum([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func TestSearchCacheRoundTripAndEmptySkip(t *testing.T) {
	setupUserTestDB(t)
	key := searchCacheKey("song", "test", "", []string{"qq"})

	// 未命中。
	if _, ok := getCachedSearch(key); ok {
		t.Fatal("should miss before put")
	}

	// 空结果不缓存。
	putCachedSearch(key, jsonSearchResponse{Type: "song", Keyword: "test"})
	if _, ok := getCachedSearch(key); ok {
		t.Fatal("empty result should not be cached")
	}

	// 有结果则缓存,含完整元数据(cover/bitrate)。
	resp := jsonSearchResponse{
		Type:    "song",
		Keyword: "test",
		Songs: []model.Track{
			{ID: "1", Name: "晴天", Artist: "周杰伦", Source: "qq", Cover: "https://x/c.jpg", Bitrate: 320},
		},
	}
	putCachedSearch(key, resp)
	cached, ok := getCachedSearch(key)
	if !ok {
		t.Fatal("should hit after put")
	}
	if len(cached.Songs) != 1 || cached.Songs[0].Cover != "https://x/c.jpg" || cached.Songs[0].Bitrate != 320 {
		t.Fatalf("cached metadata mismatch: %+v", cached.Songs)
	}
}

func TestJSONSearchCacheDeleteClearsRequestedTypes(t *testing.T) {
	setupUserTestDB(t)
	keyword := "cache-delete-test"
	songKey := searchCacheKey("song", keyword, "", defaultSourcesForSearchType("song"))
	lyricKey := searchCacheKey("lyric", keyword, "", defaultSourcesForSearchType("lyric"))
	resp := jsonSearchResponse{
		Type:    "song",
		Keyword: keyword,
		Songs:   []model.Track{{ID: "1", Name: "Cached", Source: "qq"}},
	}
	putCachedSearch(songKey, resp)
	putCachedSearch(lyricKey, resp)

	r := gin.New()
	RegisterJSONAPIRoutes(r, StartOptions{DisableAuth: true})
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/search_cache?q="+keyword+"&type=song&type=lyric", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete search cache status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Deleted int64 `json:"deleted"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Deleted != 2 {
		t.Fatalf("deleted=%d, want 2", body.Deleted)
	}
	if _, ok := getCachedSearch(songKey); ok {
		t.Fatal("song cache should be deleted")
	}
	if _, ok := getCachedSearch(lyricKey); ok {
		t.Fatal("lyric cache should be deleted")
	}
}

func TestSearchCacheStaleEntryStillReadableForRefresh(t *testing.T) {
	setupUserTestDB(t)
	key := searchCacheKey("song", "stale", "", []string{"qq"})
	resp := jsonSearchResponse{
		Type:    "song",
		Keyword: "stale",
		Sources: []string{"qq"},
		Songs:   []model.Track{{ID: "1", Name: "旧缓存", Source: "qq"}},
	}
	putCachedSearch(key, resp)
	old := time.Now().Add(-searchCacheTTL - time.Hour)
	if err := db.Model(&searchCacheRow{}).Where("key = ?", key).Update("created_at", old).Error; err != nil {
		t.Fatalf("age cache row: %v", err)
	}

	if _, ok := getCachedSearch(key); ok {
		t.Fatal("fresh-only helper should miss stale rows")
	}
	entry, ok := getSearchCacheEntry(key)
	if !ok {
		t.Fatal("stale row should remain readable for SWR response")
	}
	if entry.Fresh {
		t.Fatal("stale row should not be marked fresh")
	}
	if len(entry.Response.Songs) != 1 || entry.Response.Songs[0].Name != "旧缓存" {
		t.Fatalf("stale payload mismatch: %+v", entry.Response.Songs)
	}
}

func TestJSONSearchSkipWarmDoesNotInspectCachedResults(t *testing.T) {
	setupUserTestDB(t)
	keyword := "skip-warm-test"
	cacheKey := searchCacheKey("song", keyword, "", []string{"qq"})
	putCachedSearch(cacheKey, jsonSearchResponse{
		Type:    "song",
		Keyword: keyword,
		Sources: []string{"qq"},
		Songs: []model.Track{
			{ID: "song-1", Name: "限速测试", Artist: "Tester", Source: "qq", Duration: 100},
		},
	})

	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Range", "bytes 0-1/4000000")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte{0, 1})
	}))
	defer server.Close()

	origProvider := qualityDownloadURLProvider
	qualityDownloadURLProvider = func(song model.Track) (string, error) {
		return server.URL + "/track.mp3", nil
	}
	defer func() { qualityDownloadURLProvider = origProvider }()

	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterJSONAPIRoutes(r, StartOptions{DisableAuth: true})
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v1/search?q=%s&type=song&sources=qq&skip_warm=1", keyword), nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("search status=%d body=%s", rec.Code, rec.Body.String())
	}

	time.Sleep(150 * time.Millisecond)
	if got := hits.Load(); got != 0 {
		t.Fatalf("skip_warm should not inspect cached search results, got %d source hits", got)
	}
}

func TestAPICacheKeyOrderAndStaleMetadata(t *testing.T) {
	setupUserTestDB(t)
	argsA := apiCacheArgs{Sources: []string{"qq", "netease"}}
	argsB := apiCacheArgs{Sources: []string{"netease", "qq"}}
	keyA := apiCacheKey(apiCacheNamespaceRecommend, argsA)
	keyB := apiCacheKey(apiCacheNamespaceRecommend, argsB)
	if keyA != keyB {
		t.Fatal("api cache key should ignore source order")
	}

	resp := jsonPlaylistTabsResponse{Tabs: []jsonPlaylistTab{
		{Source: "qq", SourceName: "QQ音乐", Playlists: []model.RemoteCollection{{ID: "p1", Name: "旧歌单", Source: "qq"}}},
	}}
	putAPICache(keyA, apiCacheNamespaceRecommend, argsA, resp)
	old := time.Now().Add(-apiCacheFreshTTL() - time.Hour)
	if err := db.Model(&apiCacheRow{}).Where("key = ?", keyA).Update("created_at", old).Error; err != nil {
		t.Fatalf("age api cache row: %v", err)
	}

	entry, ok := getAPICacheEntry(keyA)
	if !ok {
		t.Fatal("api cache should hit after put")
	}
	if entry.Fresh {
		t.Fatal("aged api cache should be stale")
	}
	var cached jsonPlaylistTabsResponse
	if !decodeAPICachePayload(entry, &cached) {
		t.Fatal("decode api cache payload failed")
	}
	cached.cachedResponseMeta = cacheMetaForEntry(entry)
	if !cached.Cached || !cached.Refreshing || cached.CachedAt == nil {
		t.Fatalf("cache meta not marked for refresh: %+v", cached.cachedResponseMeta)
	}
	if got := cached.Tabs[0].Playlists[0].Name; got != "旧歌单" {
		t.Fatalf("cached playlist name = %q", got)
	}
}

func TestSearchHistoryIsolationAndDedup(t *testing.T) {
	setupUserTestDB(t)
	alice, _ := createUser("alice", "alicepass1", RoleUser)
	bob, _ := createUser("bob", "bobpass1", RoleUser)

	recordSearchHistory(alice.ID, "晴天", "song")
	recordSearchHistory(alice.ID, "稻香", "song")
	recordSearchHistory(alice.ID, "晴天", "song") // 重复:去重,不新增
	recordSearchHistory(bob.ID, "Bob搜的", "song")
	recordSearchHistory(0, "匿名", "song") // userID=0 跳过

	aliceHist, _ := listSearchHistory(alice.ID, 0)
	if len(aliceHist) != 2 {
		t.Fatalf("alice should have 2 unique entries, got %d", len(aliceHist))
	}
	// 最近搜的(晴天 重搜)排最前。
	if aliceHist[0].Keyword != "晴天" {
		t.Fatalf("most recent should be 晴天, got %s", aliceHist[0].Keyword)
	}

	bobHist, _ := listSearchHistory(bob.ID, 0)
	if len(bobHist) != 1 || bobHist[0].Keyword != "Bob搜的" {
		t.Fatalf("bob history isolation broken: %+v", bobHist)
	}

	// 链接不入历史。
	recordSearchHistory(alice.ID, "https://music.qq.com/x", "song")
	if h, _ := listSearchHistory(alice.ID, 0); len(h) != 2 {
		t.Fatalf("link should not be recorded, got %d", len(h))
	}
}

func TestSearchSuggestionsUseHistoryAndCache(t *testing.T) {
	setupUserTestDB(t)
	alice, _ := createUser("alice", "alicepass1", RoleUser)
	bob, _ := createUser("bob", "bobpass1", RoleUser)

	recordSearchHistory(alice.ID, "错位时空 艾辰", "song")
	recordSearchHistory(alice.ID, "周杰伦 晴天", "song")
	recordSearchHistory(bob.ID, "错位人生", "song")

	keywords := suggestSearchHistoryKeywords(alice.ID, "错位", 8)
	if len(keywords) != 1 || keywords[0] != "错位时空 艾辰" {
		t.Fatalf("history suggestions mismatch: %+v", keywords)
	}

	cacheKey := searchCacheKey("song", "错位时空 艾辰", "", []string{"qq", "netease"})
	putCachedSearch(cacheKey, jsonSearchResponse{
		Type:    "song",
		Keyword: "错位时空 艾辰",
		Sources: []string{"qq", "netease"},
		Songs: []model.Track{
			{ID: "2100630469", Name: "错位时空", Artist: "艾辰", Source: "netease", Album: "错位时空"},
			{ID: "004ZgdqY0Gfpq8", Name: "谁与归", Artist: "艾辰", Source: "qq", Album: "谁与归"},
		},
	})

	songs := suggestSearchCacheSongs("错位", 10)
	if len(songs) != 1 {
		t.Fatalf("cache suggestions len=%d, songs=%+v", len(songs), songs)
	}
	if songs[0].Name != "错位时空" || songs[0].Artist != "艾辰" {
		t.Fatalf("cache suggestion mismatch: %+v", songs[0])
	}
}

// TestSearchCacheDoesNotPersistPendingSources 锁住 2026-11-27 修的真实缺陷:
// 「还有 4 个源在后台补齐,结果会自动刷新」——但实际永远不会刷新。
//
// 现场证据(生产日志,关键词「爱乐之城」):
//
//	20:11:57  前台 2.5s 返回, pending=[qq kugou migu qianqian]
//	20:12:22  前端补拉一次(命中缓存, 但缓存里 pending 还是那 4 个)
//	之后      再也没有任何请求
//	20:14:32  后台补齐其实成功写入了 60 首 —— 前端早已不再来取
//
// 根因之一是缓存把"正在补齐"这个**瞬时状态**固化进了 24h 缓存行: 后台任务
// 早已完成(或随进程重启消失), 缓存却还在复述那 4 个源。现在 pending 只从
// 内存里的在跑任务派生, 不落库。
func TestSearchCacheDoesNotPersistPendingSources(t *testing.T) {
	setupUserTestDB(t)
	key := searchCacheKey("song", "爱乐之城", "", []string{"qq", "kugou", "migu", "qianqian"})

	// 前台响应本身带着 pending(慢源没等到), putCachedSearch 必须把它剥掉。
	putCachedSearch(key, jsonSearchResponse{
		Type:           "song",
		Keyword:        "爱乐之城",
		Sources:        []string{"qq", "kugou", "migu", "qianqian"},
		Songs:          []model.Track{{ID: "1", Name: "爱乐之城", Source: "netease"}},
		PendingSources: []string{"qq", "kugou", "migu", "qianqian"},
	})

	entry, ok := getSearchCacheEntry(key)
	if !ok {
		t.Fatal("should hit cache after put")
	}
	if len(entry.PendingSources) != 0 {
		t.Fatalf("缓存行不该固化 pending, 实际 = %v", entry.PendingSources)
	}

	// 直接读库确认 payload 里也没有 pending —— 否则旧版本写进去的值会在
	// 升级后继续误导前端(Payload 是 JSON，这里只关心字段是否出现)。
	var row searchCacheRow
	if err := db.Where("key = ?", key).Limit(1).Find(&row).Error; err != nil || row.Key == "" {
		t.Fatalf("read cache row: %v", err)
	}
	if strings.Contains(row.Payload, "pending_sources") {
		t.Fatalf("落库的 payload 里不该出现 pending_sources, 实际 payload=%s", row.Payload)
	}

	// 没有在跑的后台任务时, 缓存命中必须如实回答"没有源在等"。
	cached, hit := getCachedSearch(key)
	if !hit {
		t.Fatal("should hit fresh cache")
	}
	if len(cached.PendingSources) != 0 {
		t.Fatalf("没有在跑的任务却报出 pending=%v", cached.PendingSources)
	}
}

// TestSearchCacheReportsPendingOnlyWhileCompletionRuns 锁住另一半语义:
// 后台补齐**确实在跑**时, 缓存命中要如实报出还差哪些源(前端据此继续等),
// 任务结束后必须立刻消失。
func TestSearchCacheReportsPendingOnlyWhileCompletionRuns(t *testing.T) {
	setupUserTestDB(t)
	key := searchCacheKey("song", "在跑", "", []string{"qq", "kugou"})
	putCachedSearch(key, jsonSearchResponse{
		Type:    "song",
		Keyword: "在跑",
		Sources: []string{"qq", "kugou"},
		Songs:   []model.Track{{ID: "1", Name: "在跑", Source: "qq"}},
	})

	// 模拟 completeSearchCacheAsync 登记了在跑任务(登记的是具体在等哪些源)。
	searchCompletionInFlight.Store(key, []string{"kugou"})
	t.Cleanup(func() { searchCompletionInFlight.Delete(key) })

	entry, ok := getSearchCacheEntry(key)
	if !ok {
		t.Fatal("should hit cache")
	}
	if len(entry.PendingSources) != 1 || entry.PendingSources[0] != "kugou" {
		t.Fatalf("在跑的任务必须如实报出 pending, 实际 = %v", entry.PendingSources)
	}
	cached, _ := getCachedSearch(key)
	if len(cached.PendingSources) != 1 || cached.PendingSources[0] != "kugou" {
		t.Fatalf("getCachedSearch 也必须带上在跑的源, 实际 = %v", cached.PendingSources)
	}

	// 任务结束(删除登记)→ 立刻不再报 pending, 不会像旧实现那样永远说"还在补齐"。
	searchCompletionInFlight.Delete(key)
	entry, _ = getSearchCacheEntry(key)
	if len(entry.PendingSources) != 0 {
		t.Fatalf("任务结束后不该再报 pending, 实际 = %v", entry.PendingSources)
	}
}

// TestSearchCacheIgnoresLegacyPersistedPendingSources 旧版本已经把 pending 写进了库。
// 升级后读到这种旧行, 必须**以内存任务状态为准**、忽略库里那份陈旧快照,
// 否则用户会继续看到"还有 N 个源在补齐"却永远等不到刷新。
func TestSearchCacheIgnoresLegacyPersistedPendingSources(t *testing.T) {
	setupUserTestDB(t)
	key := searchCacheKey("song", "旧行", "", []string{"qq"})

	// 手工造一条"旧版本写进去的"缓存行: payload 里带着 pending_sources。
	stale := jsonSearchResponse{
		Type:           "song",
		Keyword:        "旧行",
		Sources:        []string{"qq"},
		Songs:          []model.Track{{ID: "1", Name: "旧行", Source: "qq"}},
		PendingSources: []string{"kugou", "kuwo", "migu", "qianqian"},
	}
	payload, err := json.Marshal(stale)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	if err := db.Create(&searchCacheRow{Key: key, Payload: string(payload), CreatedAt: time.Now()}).Error; err != nil {
		t.Fatalf("insert legacy row: %v", err)
	}

	entry, ok := getSearchCacheEntry(key)
	if !ok {
		t.Fatal("legacy row should still be readable")
	}
	if len(entry.PendingSources) != 0 {
		t.Fatalf("旧行里的 pending 必须被忽略(没有在跑的任务), 实际 = %v", entry.PendingSources)
	}
	cached, _ := getCachedSearch(key)
	if len(cached.PendingSources) != 0 {
		t.Fatalf("getCachedSearch 也必须忽略旧行里的 pending, 实际 = %v", cached.PendingSources)
	}
}

package web

import (
	"testing"

	"github.com/guohuiyuan/music-lib/model"
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
		Songs: []model.Song{
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

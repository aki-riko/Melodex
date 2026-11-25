package web

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/gin-gonic/gin"
)

func isolateSuggestUpstream(t *testing.T) {
	t.Helper()
	previous := suggestUpstreamFunc
	previousCache := suggestUpstreamCache.entries
	suggestUpstreamCache.entries = map[string]suggestCacheEntry{}
	t.Cleanup(func() {
		suggestUpstreamFunc = previous
		suggestUpstreamCache.entries = previousCache
	})
}

func serveSuggestions(t *testing.T, userID uint, query string) jsonSearchSuggestionsResponse {
	t.Helper()
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/suggest", func(c *gin.Context) {
		if userID != 0 {
			c.Set(ctxUserID, userID)
		}
		jsonSearchSuggestionsHandler(c)
	})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/suggest?"+url.Values{"q": {query}}.Encode(), nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("suggestions status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var resp jsonSearchSuggestionsResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode suggestions: %v (body=%s)", err, recorder.Body.String())
	}
	return resp
}

// 上游联想必须是补全的**主来源**：没有搜索历史的新用户也要能补全。
func TestSearchSuggestionsUseUpstreamTerms(t *testing.T) {
	isolateSuggestUpstream(t)
	suggestUpstreamFunc = func(keyword string, limit int) ([]core.SuggestTerm, error) {
		if keyword != "晴天" {
			t.Fatalf("upstream keyword = %q", keyword)
		}
		return []core.SuggestTerm{
			{Kind: "song", Name: "晴天", Detail: "周杰伦"},
			{Kind: "singer", Name: "周杰伦"},
			{Kind: "album", Name: "叶惠美", Detail: "周杰伦"},
		}, nil
	}

	resp := serveSuggestions(t, 0, "晴天")
	if !resp.Upstream {
		t.Fatal("upstream flag should be true when the provider answered")
	}
	if len(resp.Terms) != 3 {
		t.Fatalf("terms = %+v", resp.Terms)
	}
	if resp.Terms[0].Name != "晴天" || resp.Terms[0].Detail != "周杰伦" || resp.Terms[0].Kind != "song" {
		t.Fatalf("first term = %+v", resp.Terms[0])
	}
	if len(resp.Keywords) != 3 || resp.Keywords[1] != "周杰伦" {
		t.Fatalf("keywords = %+v", resp.Keywords)
	}
}

// 上游挂了必须降级而不是整体失败：历史照样要能补出来。
func TestSearchSuggestionsFallBackToHistoryWhenUpstreamFails(t *testing.T) {
	isolateSuggestUpstream(t)
	setupUserTestDB(t)
	alice, _ := createUser("alice", "alicepass1", RoleUser)
	recordSearchHistory(alice.ID, "晴天 周杰伦", "song")
	suggestUpstreamFunc = func(string, int) ([]core.SuggestTerm, error) {
		return nil, errors.New("provider down")
	}

	resp := serveSuggestions(t, alice.ID, "晴天")
	if resp.Upstream {
		t.Fatal("upstream flag must be false when the provider failed")
	}
	if len(resp.Terms) != 1 || resp.Terms[0].Name != "晴天 周杰伦" {
		t.Fatalf("degraded terms = %+v", resp.Terms)
	}
	if resp.Terms[0].Kind != "history" {
		t.Fatalf("degraded term kind = %q, want history", resp.Terms[0].Kind)
	}
}

// 历史命中的词要借用上游的类型/副标题，否则列表一半有副标题一半没有。
func TestSearchSuggestionsPreferHistoryButBorrowUpstreamDetail(t *testing.T) {
	isolateSuggestUpstream(t)
	setupUserTestDB(t)
	alice, _ := createUser("alice", "alicepass1", RoleUser)
	recordSearchHistory(alice.ID, "晴天", "song")
	suggestUpstreamFunc = func(string, int) ([]core.SuggestTerm, error) {
		return []core.SuggestTerm{{Kind: "song", Name: "晴天", Detail: "周杰伦"}}, nil
	}

	resp := serveSuggestions(t, alice.ID, "晴")
	if len(resp.Terms) != 1 {
		t.Fatalf("history and upstream must merge into one term, got %+v", resp.Terms)
	}
	term := resp.Terms[0]
	if term.Name != "晴天" {
		t.Fatalf("term name = %q", term.Name)
	}
	if term.Kind != "song" || term.Detail != "周杰伦" {
		t.Fatalf("history term should borrow upstream kind/detail, got %+v", term)
	}
}

// 同名词条(歌与专辑同名)必须合并 —— 两条点了发同一个搜索。
func TestSearchSuggestionsMergeSameNameAcrossKinds(t *testing.T) {
	isolateSuggestUpstream(t)
	suggestUpstreamFunc = func(string, int) ([]core.SuggestTerm, error) {
		return []core.SuggestTerm{
			{Kind: "song", Name: "晴天", Detail: "周杰伦"},
			{Kind: "album", Name: "晴天", Detail: "周杰伦"},
			{Kind: "album", Name: "叶惠美", Detail: "周杰伦"},
		}, nil
	}
	resp := serveSuggestions(t, 0, "晴天")
	if len(resp.Terms) != 2 {
		t.Fatalf("same name across kinds must merge, got %+v", resp.Terms)
	}
	if resp.Terms[0].Name != "晴天" || resp.Terms[1].Name != "叶惠美" {
		t.Fatalf("terms = %+v", resp.Terms)
	}
}

// 上游结果必须缓存：边打字会连发多次相同前缀的请求。
func TestSearchSuggestionsCacheUpstreamCalls(t *testing.T) {
	isolateSuggestUpstream(t)
	calls := 0
	suggestUpstreamFunc = func(string, int) ([]core.SuggestTerm, error) {
		calls++
		return []core.SuggestTerm{{Kind: "song", Name: "晴天"}}, nil
	}
	serveSuggestions(t, 0, "晴天")
	serveSuggestions(t, 0, "晴天")
	serveSuggestions(t, 0, "晴天 ")
	if calls != 1 {
		t.Fatalf("upstream called %d times, want 1 (cache must absorb repeats)", calls)
	}
}

// 失败**不能**被缓存 —— 否则上游抖一下会让这个词 2 分钟都没有补全。
func TestSearchSuggestionsDoNotCacheUpstreamFailure(t *testing.T) {
	isolateSuggestUpstream(t)
	calls := 0
	suggestUpstreamFunc = func(string, int) ([]core.SuggestTerm, error) {
		calls++
		if calls == 1 {
			return nil, errors.New("transient")
		}
		return []core.SuggestTerm{{Kind: "song", Name: "晴天"}}, nil
	}
	first := serveSuggestions(t, 0, "晴天")
	if first.Upstream || len(first.Terms) != 0 {
		t.Fatalf("first (failing) response = %+v", first)
	}
	second := serveSuggestions(t, 0, "晴天")
	if !second.Upstream || len(second.Terms) != 1 {
		t.Fatalf("retry must reach upstream again, got %+v", second)
	}
	if calls != 2 {
		t.Fatalf("upstream calls = %d, want 2", calls)
	}
}

func TestSearchSuggestionsSkipLinksAndEmptyQueries(t *testing.T) {
	isolateSuggestUpstream(t)
	called := false
	suggestUpstreamFunc = func(string, int) ([]core.SuggestTerm, error) {
		called = true
		return nil, nil
	}
	for _, query := range []string{"", "   ", "https://music.163.com/song?id=1"} {
		resp := serveSuggestions(t, 0, query)
		if len(resp.Terms) != 0 || resp.Upstream {
			t.Fatalf("query %q should return nothing, got %+v", query, resp)
		}
	}
	if called {
		t.Fatal("links/empty queries must not hit the provider")
	}
}

// 单字也要能补全（实测平台支持：搜「晴」能给出「晴天」）。
// 旧实现在这里要求 >= 2 个字符，等于广东话里最常输入的单字全都没补全。
func TestSearchSuggestionsAllowSingleCJKCharacter(t *testing.T) {
	isolateSuggestUpstream(t)
	suggestUpstreamFunc = func(keyword string, _ int) ([]core.SuggestTerm, error) {
		if keyword != "晴" {
			t.Fatalf("keyword = %q", keyword)
		}
		return []core.SuggestTerm{{Kind: "song", Name: "晴天", Detail: "周杰伦"}}, nil
	}
	resp := serveSuggestions(t, 0, "晴")
	if len(resp.Terms) != 1 {
		t.Fatalf("single CJK char should be completed, got %+v", resp)
	}
}

// 纯标点/空白输入没有意义，不该请求上游。
func TestSearchSuggestionsSkipPunctuationOnlyQuery(t *testing.T) {
	isolateSuggestUpstream(t)
	called := false
	suggestUpstreamFunc = func(string, int) ([]core.SuggestTerm, error) {
		called = true
		return nil, nil
	}
	resp := serveSuggestions(t, 0, "···")
	if called || len(resp.Terms) != 0 {
		t.Fatalf("punctuation-only query should be ignored, got %+v (called=%v)", resp, called)
	}
}

// 缓存上限必须生效：随机前缀不能把内存打满。
func TestSuggestCacheRespectsMaxEntries(t *testing.T) {
	isolateSuggestUpstream(t)
	for index := 0; index < searchSuggestionUpstreamCacheMax+50; index++ {
		writeSuggestCache("key"+string(rune('a'+index%26))+strconv.Itoa(index), nil)
	}
	suggestUpstreamCache.Lock()
	size := len(suggestUpstreamCache.entries)
	suggestUpstreamCache.Unlock()
	if size > searchSuggestionUpstreamCacheMax {
		t.Fatalf("cache size = %d, exceeds max %d", size, searchSuggestionUpstreamCacheMax)
	}
}

func TestSuggestCacheExpires(t *testing.T) {
	isolateSuggestUpstream(t)
	suggestUpstreamCache.entries["过期"] = suggestCacheEntry{
		terms:    []core.SuggestTerm{{Name: "旧结果"}},
		expireAt: time.Now().Add(-time.Second),
	}
	if _, ok := readSuggestCache("过期"); ok {
		t.Fatal("expired entry must not be served")
	}
	suggestUpstreamCache.Lock()
	_, stillThere := suggestUpstreamCache.entries["过期"]
	suggestUpstreamCache.Unlock()
	if stillThere {
		t.Fatal("expired entry should be dropped on read")
	}
}

// 结果缓存里的歌仍然是有效建议（带封面的真实候选）。
func TestSearchSuggestionsIncludeCachedSongs(t *testing.T) {
	isolateSuggestUpstream(t)
	setupUserTestDB(t)
	suggestUpstreamFunc = func(string, int) ([]core.SuggestTerm, error) {
		return []core.SuggestTerm{{Kind: "song", Name: "晴天", Detail: "周杰伦"}}, nil
	}
	cacheKey := searchCacheKey("song", "晴天 周杰伦", "", []string{"qq"})
	putCachedSearch(cacheKey, jsonSearchResponse{
		Type:    "song",
		Keyword: "晴天 周杰伦",
		Sources: []string{"qq"},
		Songs: []model.Track{
			{ID: "0039MnYb0qxYhV", Name: "晴天", Artist: "周杰伦", Source: "qq"},
			{ID: "other", Name: "无关", Artist: "别人", Source: "qq"},
		},
	})
	resp := serveSuggestions(t, 0, "晴天")
	if len(resp.Songs) != 1 || resp.Songs[0].Name != "晴天" {
		t.Fatalf("cached song suggestions = %+v", resp.Songs)
	}
}

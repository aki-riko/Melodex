package web

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/gin-gonic/gin"
)

const searchSuggestionDefaultLimit = 24
const searchSuggestionMaxLimit = 60
const searchSuggestionCacheScanRows = 240

// searchSuggestionUpstreamLimit 是向上游(平台联想接口)要多少条。
//
// 比返回给前端的总数小是有意的:上游词条只是"平台认为的候选前缀",最终列表还要与
// 本地搜索历史合并去重。要太多会让上游变慢(补全对延迟极敏感)。
const searchSuggestionUpstreamLimit = 10

// searchSuggestionUpstreamTTL 是上游联想结果的进程内缓存时长。
//
// 补全是"边打字边请求":用户输「晴」「晴天」「晴天周」会连发三次,而前两次的答案
// 在几百毫秒内就重复了。缓存 2 分钟能吃掉绝大多数重复 —— 同一个前缀的联想结果
// 在两分钟内不会因为刷新而变,平台的热度榜也不按秒更新。
const searchSuggestionUpstreamTTL = 2 * time.Minute

// searchSuggestionUpstreamCacheMax 限制缓存条目数,防止有人用随机字符串把内存打满。
const searchSuggestionUpstreamCacheMax = 512

type jsonSearchSuggestionsResponse struct {
	// Keywords 保留给"只想要一串可搜文本"的调用方(搜索历史 + 上游词条名)。
	Keywords []string `json:"keywords"`
	// Terms 是结构化词条:上游给的类型(歌/歌手/专辑)与副标题。
	// 前端用它显示图标与"歌名 · 歌手",点任意一条都是用 Name 去搜。
	Terms []jsonSearchSuggestionTerm `json:"terms"`
	Songs []model.Track              `json:"songs"`
	// Upstream 标记这次联想是否真的拿到了平台权威词条。
	// false 表示降级成"只用本地历史 + 结果缓存",前端据此可以调整文案。
	Upstream bool   `json:"upstream"`
	Error    string `json:"error,omitempty"`
}

type jsonSearchSuggestionTerm struct {
	Kind   string `json:"kind"`
	Name   string `json:"name"`
	Detail string `json:"detail,omitempty"`
}

// suggestUpstreamFunc 允许测试替换上游调用(不打真实网络)。
var suggestUpstreamFunc = core.SuggestSongs

type suggestCacheEntry struct {
	terms    []core.SuggestTerm
	expireAt time.Time
}

var suggestUpstreamCache = struct {
	sync.Mutex
	entries map[string]suggestCacheEntry
}{entries: map[string]suggestCacheEntry{}}

func jsonSearchSuggestionsHandler(c *gin.Context) {
	query := strings.TrimSpace(c.Query("q"))
	limit := parseSearchSuggestionLimit(c.Query("limit"))
	resp := jsonSearchSuggestionsResponse{
		Keywords: []string{},
		Terms:    []jsonSearchSuggestionTerm{},
		Songs:    []model.Track{},
	}
	if query == "" || len([]rune(compactSuggestionText(query))) < 1 {
		c.JSON(http.StatusOK, resp)
		return
	}
	if strings.HasPrefix(strings.ToLower(query), "http") {
		c.JSON(http.StatusOK, resp)
		return
	}

	// ① 平台权威联想(带缓存)。失败不影响响应 —— 只是上游那部分为空。
	upstreamTerms, upstreamOK := fetchUpstreamSuggestionTerms(query)
	resp.Upstream = upstreamOK

	// ② 本地搜索历史里匹配的词(用户自己的习惯,命中时优先显示)。
	historyKeywords := suggestSearchHistoryKeywords(currentUserID(c), query, 8)

	// ③ 合并词条:历史优先(它更贴近"这个人想找什么"),再补上游。
	resp.Terms = mergeSuggestionTerms(historyKeywords, upstreamTerms, limit)
	resp.Keywords = suggestionTermNames(resp.Terms, 8)

	// ④ 歌曲级建议(带封面的真实候选),仍来自本地结果缓存。
	// 有上游词条时仍然要给:native 出现在列表里能让人直接点播,不必再搜一次。
	resp.Songs = suggestSearchCacheSongs(query, limit)
	c.JSON(http.StatusOK, resp)
}

// fetchUpstreamSuggestionTerms 取平台联想词,进程内缓存 2 分钟。
//
// 返回值第二项表示"上游可用"(即使结果为空)。区分「上游失败」与「上游确实没这个词」
// 是有意义的:前者前端可以提示"补全服务暂时不可用",后者就是真的没有。
func fetchUpstreamSuggestionTerms(query string) ([]core.SuggestTerm, bool) {
	key := compactSuggestionText(query)
	if key == "" {
		return nil, false
	}
	if terms, ok := readSuggestCache(key); ok {
		return terms, true
	}
	terms, err := suggestUpstreamFunc(query, searchSuggestionUpstreamLimit)
	if err != nil {
		// 不缓存失败:上游抖动一下不该让这个词 2 分钟都没有补全。
		return nil, false
	}
	writeSuggestCache(key, terms)
	return terms, true
}

func readSuggestCache(key string) ([]core.SuggestTerm, bool) {
	suggestUpstreamCache.Lock()
	defer suggestUpstreamCache.Unlock()
	entry, ok := suggestUpstreamCache.entries[key]
	if !ok {
		return nil, false
	}
	if time.Now().After(entry.expireAt) {
		delete(suggestUpstreamCache.entries, key)
		return nil, false
	}
	return entry.terms, true
}

func writeSuggestCache(key string, terms []core.SuggestTerm) {
	suggestUpstreamCache.Lock()
	defer suggestUpstreamCache.Unlock()
	// 顺手淘汰过期项;条目仍超上限时按过期时间剔掉最早到期的一批。
	now := time.Now()
	for cacheKey, entry := range suggestUpstreamCache.entries {
		if now.After(entry.expireAt) {
			delete(suggestUpstreamCache.entries, cacheKey)
		}
	}
	if len(suggestUpstreamCache.entries) >= searchSuggestionUpstreamCacheMax {
		type expiredPair struct {
			key      string
			expireAt time.Time
		}
		pairs := make([]expiredPair, 0, len(suggestUpstreamCache.entries))
		for cacheKey, entry := range suggestUpstreamCache.entries {
			pairs = append(pairs, expiredPair{key: cacheKey, expireAt: entry.expireAt})
		}
		sort.Slice(pairs, func(i, j int) bool { return pairs[i].expireAt.Before(pairs[j].expireAt) })
		for _, pair := range pairs[:len(pairs)/2+1] {
			delete(suggestUpstreamCache.entries, pair.key)
		}
	}
	suggestUpstreamCache.entries[key] = suggestCacheEntry{
		terms:    terms,
		expireAt: now.Add(searchSuggestionUpstreamTTL),
	}
}

// mergeSuggestionTerms 合并历史词与上游词条。
//
// 规则:
//   - 历史命中的词**优先**(它是这个人真的搜过的),但要借用上游给的类型/副标题,
//     否则列表里一半有副标题一半没有,看着像坏了一半;
//   - 去重按规范化名字,与上游模块的规则保持同一套(忽略大小写/空白/标点),
//     否则「晴天 (Live)」和「晴天(Live)」会并排出现;
//   - 输出顺序稳定:历史段在前,上游段保持平台给的顺序。
func mergeSuggestionTerms(historyKeywords []string, upstreamTerms []core.SuggestTerm, limit int) []jsonSearchSuggestionTerm {
	if limit <= 0 {
		return []jsonSearchSuggestionTerm{}
	}
	out := make([]jsonSearchSuggestionTerm, 0, limit)
	seen := make(map[string]struct{}, limit)

	type upstreamInfo struct {
		kind   string
		detail string
		name   string
	}
	upstreamByKey := make(map[string]upstreamInfo, len(upstreamTerms))
	for _, term := range upstreamTerms {
		key := compactSuggestionText(term.Name)
		if key == "" {
			continue
		}
		if _, exists := upstreamByKey[key]; !exists {
			upstreamByKey[key] = upstreamInfo{kind: term.Kind, detail: term.Detail, name: term.Name}
		}
	}

	for _, keyword := range historyKeywords {
		key := compactSuggestionText(keyword)
		if key == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		term := jsonSearchSuggestionTerm{Kind: "history", Name: strings.TrimSpace(keyword)}
		// 历史词恰好也是上游候选时,补上平台给的类型与副标题。
		if info, ok := upstreamByKey[key]; ok {
			term.Kind = firstNonEmptySuggestionValue(info.kind, "history")
			term.Detail = info.detail
		}
		out = append(out, term)
		if len(out) >= limit {
			return out
		}
	}

	for _, term := range upstreamTerms {
		key := compactSuggestionText(term.Name)
		if key == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, jsonSearchSuggestionTerm{
			Kind:   strings.TrimSpace(term.Kind),
			Name:   strings.TrimSpace(term.Name),
			Detail: strings.TrimSpace(term.Detail),
		})
		if len(out) >= limit {
			return out
		}
	}
	return out
}

func suggestionTermNames(terms []jsonSearchSuggestionTerm, limit int) []string {
	names := make([]string, 0, min(len(terms), limit))
	seen := make(map[string]struct{}, len(terms))
	for _, term := range terms {
		name := strings.TrimSpace(term.Name)
		if name == "" {
			continue
		}
		key := compactSuggestionText(name)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		names = append(names, name)
		if len(names) >= limit {
			break
		}
	}
	return names
}

func firstNonEmptySuggestionValue(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func parseSearchSuggestionLimit(raw string) int {
	limit, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || limit <= 0 {
		return searchSuggestionDefaultLimit
	}
	if limit > searchSuggestionMaxLimit {
		return searchSuggestionMaxLimit
	}
	return limit
}

func suggestSearchHistoryKeywords(userID uint, query string, limit int) []string {
	if userID == 0 || limit <= 0 {
		return []string{}
	}
	rows, err := listSearchHistory(userID, 0)
	if err != nil {
		return []string{}
	}
	q := compactSuggestionText(query)
	out := make([]string, 0, limit)
	seen := map[string]struct{}{}
	for _, row := range rows {
		keyword := strings.TrimSpace(row.Keyword)
		key := compactSuggestionText(keyword)
		if keyword == "" || key == "" || !strings.Contains(key, q) {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, keyword)
		if len(out) >= limit {
			break
		}
	}
	return out
}

func suggestSearchCacheSongs(query string, limit int) []model.Track {
	if db == nil || limit <= 0 {
		return []model.Track{}
	}
	var rows []searchCacheRow
	like := "%" + strings.ToLower(strings.TrimSpace(query)) + "%"
	if err := db.Where("LOWER(payload) LIKE ?", like).
		Order("created_at DESC").
		Limit(searchSuggestionCacheScanRows).
		Find(&rows).Error; err != nil {
		return []model.Track{}
	}
	q := compactSuggestionText(query)
	out := make([]model.Track, 0, limit)
	seen := map[string]struct{}{}
	for _, row := range rows {
		var cached jsonSearchResponse
		if err := json.Unmarshal([]byte(row.Payload), &cached); err != nil {
			continue
		}
		for _, song := range cached.Songs {
			if !songMatchesSuggestion(song, q) {
				continue
			}
			key := searchSuggestionSongKey(song)
			if key == "" {
				continue
			}
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, song)
			if len(out) >= limit {
				return out
			}
		}
	}
	return out
}

func songMatchesSuggestion(song model.Track, compactQuery string) bool {
	if compactQuery == "" {
		return false
	}
	haystack := compactSuggestionText(strings.Join([]string{
		song.Name,
		song.Artist,
		song.Album,
	}, " "))
	return strings.Contains(haystack, compactQuery)
}

func searchSuggestionSongKey(song model.Track) string {
	source := strings.TrimSpace(song.Source)
	id := strings.TrimSpace(song.ID)
	if source != "" && id != "" {
		return source + ":" + id
	}
	title := compactSuggestionText(song.Name)
	if title == "" {
		return ""
	}
	return strings.Join([]string{
		source,
		title,
		compactSuggestionText(song.Artist),
		strconv.Itoa(song.Duration),
	}, ":")
}

func compactSuggestionText(value string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(value) {
		if unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) {
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

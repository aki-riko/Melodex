package web

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"unicode"

	"github.com/gin-gonic/gin"
	"github.com/guohuiyuan/music-lib/model"
)

const searchSuggestionDefaultLimit = 24
const searchSuggestionMaxLimit = 60
const searchSuggestionCacheScanRows = 240

type jsonSearchSuggestionsResponse struct {
	Keywords []string     `json:"keywords"`
	Songs    []model.Song `json:"songs"`
	Error    string       `json:"error,omitempty"`
}

func jsonSearchSuggestionsHandler(c *gin.Context) {
	query := strings.TrimSpace(c.Query("q"))
	limit := parseSearchSuggestionLimit(c.Query("limit"))
	resp := jsonSearchSuggestionsResponse{
		Keywords: []string{},
		Songs:    []model.Song{},
	}
	if query == "" || len([]rune(compactSuggestionText(query))) < 2 {
		c.JSON(http.StatusOK, resp)
		return
	}
	if strings.HasPrefix(strings.ToLower(query), "http") {
		c.JSON(http.StatusOK, resp)
		return
	}

	resp.Keywords = suggestSearchHistoryKeywords(currentUserID(c), query, 8)
	resp.Songs = suggestSearchCacheSongs(query, limit)
	c.JSON(http.StatusOK, resp)
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

func suggestSearchCacheSongs(query string, limit int) []model.Song {
	if db == nil || limit <= 0 {
		return []model.Song{}
	}
	var rows []searchCacheRow
	like := "%" + strings.ToLower(strings.TrimSpace(query)) + "%"
	if err := db.Where("LOWER(payload) LIKE ?", like).
		Order("created_at DESC").
		Limit(searchSuggestionCacheScanRows).
		Find(&rows).Error; err != nil {
		return []model.Song{}
	}
	q := compactSuggestionText(query)
	out := make([]model.Song, 0, limit)
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

func songMatchesSuggestion(song model.Song, compactQuery string) bool {
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

func searchSuggestionSongKey(song model.Song) string {
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

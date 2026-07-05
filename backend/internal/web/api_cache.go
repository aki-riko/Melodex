package web

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"log"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm/clause"
)

const (
	apiCacheNamespaceRecommend         = "recommend"
	apiCacheNamespacePlaylistDetail    = "playlist_detail"
	apiCacheNamespaceAlbumDetail       = "album_detail"
	apiCacheNamespacePlaylistCategory  = "playlist_categories"
	apiCacheNamespaceCategoryPlaylists = "category_playlists"
)

const (
	apiCacheDefaultFreshTTL       = time.Hour
	apiCacheDefaultMaxAge         = 7 * 24 * time.Hour
	apiCacheDefaultRefreshEvery   = 15 * time.Minute
	apiCacheBackgroundRefreshRows = 20
	apiCacheMaxRows               = 5000
)

type cachedResponseMeta struct {
	Cached     bool       `json:"cached,omitempty"`
	Refreshing bool       `json:"refreshing,omitempty"`
	CachedAt   *time.Time `json:"cached_at,omitempty"`
}

type apiCacheRow struct {
	Key       string    `gorm:"primaryKey;size:64" json:"-"`
	Namespace string    `gorm:"index;size:64;not null" json:"namespace"`
	Args      string    `gorm:"type:text;not null" json:"-"`
	Payload   string    `gorm:"type:text;not null" json:"-"`
	CreatedAt time.Time `gorm:"autoCreateTime;index" json:"-"`
}

type apiCacheArgs struct {
	Sources    []string `json:"sources,omitempty"`
	Source     string   `json:"source,omitempty"`
	ID         string   `json:"id,omitempty"`
	CategoryID string   `json:"category_id,omitempty"`
}

type apiCacheEntry struct {
	Row        apiCacheRow
	Fresh      bool
	Expired    bool
	Refreshing bool
}

var (
	apiCacheLastGC        time.Time
	apiCacheGCMu          sync.Mutex
	apiCacheRefreshFlight sync.Map
)

func apiCacheKey(namespace string, args apiCacheArgs) string {
	args = normalizedAPICacheArgs(args)
	rawArgs, _ := json.Marshal(args)
	raw := strings.Join([]string{strings.TrimSpace(namespace), string(rawArgs)}, "\x00")
	sum := sha1.Sum([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func normalizedAPICacheArgs(args apiCacheArgs) apiCacheArgs {
	args.Source = strings.ToLower(strings.TrimSpace(args.Source))
	args.ID = strings.TrimSpace(args.ID)
	args.CategoryID = strings.TrimSpace(args.CategoryID)
	if len(args.Sources) > 0 {
		sources := make([]string, 0, len(args.Sources))
		for _, source := range args.Sources {
			source = strings.ToLower(strings.TrimSpace(source))
			if source != "" {
				sources = append(sources, source)
			}
		}
		sort.Strings(sources)
		args.Sources = sources
	}
	return args
}

func getAPICacheEntry(key string) (apiCacheEntry, bool) {
	if db == nil || strings.TrimSpace(key) == "" {
		return apiCacheEntry{}, false
	}
	var row apiCacheRow
	if err := db.Where("key = ?", key).Limit(1).Find(&row).Error; err != nil || row.Key == "" {
		return apiCacheEntry{}, false
	}
	maxAge := apiCacheMaxAge()
	if maxAge > 0 && time.Since(row.CreatedAt) > maxAge {
		db.Where("key = ?", key).Delete(&apiCacheRow{})
		return apiCacheEntry{}, false
	}
	freshTTL := apiCacheFreshTTL()
	fresh := freshTTL <= 0 || time.Since(row.CreatedAt) <= freshTTL
	_, refreshing := apiCacheRefreshFlight.Load(row.Key)
	return apiCacheEntry{Row: row, Fresh: fresh, Refreshing: refreshing}, true
}

func putAPICache(key, namespace string, args apiCacheArgs, payload interface{}) {
	if db == nil || strings.TrimSpace(key) == "" {
		return
	}
	args = normalizedAPICacheArgs(args)
	argsData, err := json.Marshal(args)
	if err != nil {
		return
	}
	payloadData, err := json.Marshal(payload)
	if err != nil {
		return
	}
	db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"namespace", "args", "payload", "created_at",
		}),
	}).Create(&apiCacheRow{
		Key:       key,
		Namespace: strings.TrimSpace(namespace),
		Args:      string(argsData),
		Payload:   string(payloadData),
		CreatedAt: time.Now(),
	})
	maybeGCAPICache()
}

func decodeAPICachePayload(entry apiCacheEntry, out interface{}) bool {
	if strings.TrimSpace(entry.Row.Payload) == "" {
		return false
	}
	return json.Unmarshal([]byte(entry.Row.Payload), out) == nil
}

func cacheMetaForEntry(entry apiCacheEntry) cachedResponseMeta {
	cachedAt := entry.Row.CreatedAt
	return cachedResponseMeta{
		Cached:     true,
		Refreshing: !entry.Fresh || entry.Refreshing,
		CachedAt:   &cachedAt,
	}
}

func apiCacheFreshTTL() time.Duration {
	return durationFromEnv("MUSIC_DL_API_CACHE_FRESH_TTL", apiCacheDefaultFreshTTL)
}

func apiCacheMaxAge() time.Duration {
	return durationFromEnv("MUSIC_DL_API_CACHE_MAX_AGE", apiCacheDefaultMaxAge)
}

func apiCacheRefreshEvery() time.Duration {
	return durationFromEnv("MUSIC_DL_API_CACHE_REFRESH_INTERVAL", apiCacheDefaultRefreshEvery)
}

func maybeGCAPICache() {
	apiCacheGCMu.Lock()
	defer apiCacheGCMu.Unlock()
	if time.Since(apiCacheLastGC) < 5*time.Minute {
		return
	}
	apiCacheLastGC = time.Now()

	maxAge := apiCacheMaxAge()
	if maxAge > 0 {
		db.Where("created_at < ?", time.Now().Add(-maxAge)).Delete(&apiCacheRow{})
	}

	var n int64
	if db.Model(&apiCacheRow{}).Count(&n).Error == nil && n > apiCacheMaxRows {
		var threshold apiCacheRow
		if err := db.Order("created_at DESC").Offset(apiCacheMaxRows - 1).Limit(1).Find(&threshold).Error; err == nil && threshold.Key != "" {
			db.Where("created_at < ?", threshold.CreatedAt).Delete(&apiCacheRow{})
		}
	}
}

func refreshStaleAPICacheRows(limit int) {
	if db == nil {
		return
	}
	if limit <= 0 {
		limit = apiCacheBackgroundRefreshRows
	}
	var rows []apiCacheRow
	if err := db.Where("created_at < ?", time.Now().Add(-apiCacheFreshTTL())).
		Order("created_at ASC").
		Limit(limit).
		Find(&rows).Error; err != nil {
		return
	}
	for _, row := range rows {
		refreshAPICacheRowAsync(row)
	}
}

func durationFromEnv(name string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	duration, err := time.ParseDuration(raw)
	if err != nil {
		log.Printf("[cache] invalid %s=%q, using %s", name, raw, fallback)
		return fallback
	}
	return duration
}

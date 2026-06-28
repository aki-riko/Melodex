package web

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm/clause"
)

// 搜索结果缓存:同一查询(type+sources+keyword+exactArtist)的完整结果(含 cover/bitrate
// 等所有元数据)缓存到 settings.db,TTL 内重复搜索直接返回,不重复打上游。
// 结果与用户无关,全局共享(不按用户隔离)。链接解析模式不缓存。
const searchCacheTTL = 24 * time.Hour

// searchCacheRow 一行缓存。Key 为查询指纹,Payload 为 jsonSearchResponse 的 JSON。
type searchCacheRow struct {
	Key       string    `gorm:"primaryKey;size:64" json:"-"`
	Payload   string    `gorm:"type:text;not null" json:"-"`
	CreatedAt time.Time `gorm:"autoCreateTime" json:"-"`
}

// searchCacheKey 计算查询指纹。sources 排序后参与,保证顺序无关。
func searchCacheKey(searchType, keyword, exactArtist string, sources []string) string {
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

// getCachedSearch 命中且未过期返回缓存的响应;否则返回 false。
func getCachedSearch(key string) (jsonSearchResponse, bool) {
	var resp jsonSearchResponse
	if db == nil {
		return resp, false
	}
	var row searchCacheRow
	if err := db.Where("key = ?", key).Limit(1).Find(&row).Error; err != nil {
		return resp, false
	}
	if row.Key == "" {
		return resp, false
	}
	if time.Since(row.CreatedAt) > searchCacheTTL {
		// 过期:顺手删除,返回未命中。
		db.Where("key = ?", key).Delete(&searchCacheRow{})
		return resp, false
	}
	if err := json.Unmarshal([]byte(row.Payload), &resp); err != nil {
		return resp, false
	}
	return resp, true
}

// putCachedSearch 写入/更新缓存。空结果不缓存(避免把"暂时搜不到"固化)。
func putCachedSearch(key string, resp jsonSearchResponse) {
	if db == nil || key == "" {
		return
	}
	if len(resp.Songs) == 0 && len(resp.Playlists) == 0 {
		return
	}
	data, err := json.Marshal(resp)
	if err != nil {
		return
	}
	db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"payload", "created_at"}),
	}).Create(&searchCacheRow{Key: key, Payload: string(data), CreatedAt: time.Now()})
	maybeGCSearchCache()
}

const searchCacheMaxRows = 5000

var searchCacheLastGC time.Time
var searchCacheGCMu sync.Mutex

// maybeGCSearchCache 节流地清理:先删过期行,再在总行数超上限时按 created_at 删最旧的,
// 防止用大量不同关键词无限撑大 settings.db。最多每 5 分钟跑一次。
func maybeGCSearchCache() {
	searchCacheGCMu.Lock()
	defer searchCacheGCMu.Unlock()
	if time.Since(searchCacheLastGC) < 5*time.Minute {
		return
	}
	searchCacheLastGC = time.Now()
	// 删过期
	db.Where("created_at < ?", time.Now().Add(-searchCacheTTL)).Delete(&searchCacheRow{})
	// 超量则删最旧
	var n int64
	if db.Model(&searchCacheRow{}).Count(&n).Error == nil && n > searchCacheMaxRows {
		var threshold searchCacheRow
		if err := db.Order("created_at DESC").Offset(searchCacheMaxRows - 1).Limit(1).Find(&threshold).Error; err == nil && threshold.Key != "" {
			db.Where("created_at < ?", threshold.CreatedAt).Delete(&searchCacheRow{})
		}
	}
}

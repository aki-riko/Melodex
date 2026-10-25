package web

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	qualityCacheValidTTL   = 7 * 24 * time.Hour
	qualityCacheInvalidTTL = time.Hour
	qualityCacheMaxRows    = 20000
	qqQualityProbeVersion  = "qq-vkey-ag1-refreshkey"
)

type qualityCacheRow struct {
	Key        string    `gorm:"primaryKey;size:64" json:"-"`
	SongID     string    `gorm:"index;not null" json:"id"`
	Source     string    `gorm:"index;not null" json:"source"`
	ExtraHash  string    `gorm:"size:64" json:"extra_hash"`
	Valid      bool      `gorm:"not null" json:"valid"`
	URL        string    `gorm:"type:text" json:"-"`
	SizeBytes  int64     `json:"size_bytes"`
	SizeText   string    `json:"size"`
	Bitrate    string    `json:"bitrate"`
	BitrateNum int       `json:"bitrate_num"`
	CheckedAt  time.Time `gorm:"index;not null" json:"checked_at"`
}

type qualityInspectResult struct {
	Valid      bool
	URL        string
	SizeBytes  int64
	SizeText   string
	Bitrate    string
	BitrateNum int
	Cached     bool
	CheckedAt  time.Time
}

var (
	qualityDownloadURLProvider = resolveQualityDownloadURL
	qualityWarmInFlight        sync.Map
	qualityCacheLastGC         time.Time
	qualityCacheGCMu           sync.Mutex
)

func inspectSongQualityCached(song model.Track, duration int) qualityInspectResult {
	if cached, ok := getCachedQuality(song, duration); ok {
		return cached
	}
	result := inspectSongQuality(song, duration)
	putQualityCache(song, result)
	return result
}

func inspectSongQuality(song model.Track, duration int) qualityInspectResult {
	source := strings.TrimSpace(song.Source)
	id := strings.TrimSpace(song.ID)
	if source == "" || id == "" {
		return qualityInvalidResult()
	}

	urlStr, err := qualityDownloadURLProvider(song)
	if err != nil || strings.TrimSpace(urlStr) == "" {
		return qualityInvalidResult()
	}

	req, reqErr := core.BuildSourceRequest(http.MethodGet, urlStr, source, "bytes=0-1")
	if reqErr != nil {
		return qualityInvalidResult()
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)

	valid := false
	var size int64

	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusPartialContent {
			valid = true
			if cr := resp.Header.Get("Content-Range"); cr != "" {
				if parts := strings.Split(cr, "/"); len(parts) == 2 {
					size, _ = strconv.ParseInt(parts[1], 10, 64)
				}
			}
			if size <= 0 && resp.ContentLength > 0 {
				size = resp.ContentLength
			}
		}
	}

	bitrate, bitrateNum := qualityBitrate(size, duration)
	return qualityInspectResult{
		Valid:      valid,
		URL:        urlStr,
		SizeBytes:  size,
		SizeText:   core.FormatSize(size),
		Bitrate:    bitrate,
		BitrateNum: bitrateNum,
		CheckedAt:  time.Now(),
	}
}

func resolveQualityDownloadURL(song model.Track) (string, error) {
	fn := core.GetDownloadFunc(song.Source)
	if fn == nil {
		return "", fmt.Errorf("unsupported source")
	}
	return fn(&song)
}

func qualityInvalidResult() qualityInspectResult {
	return qualityInspectResult{
		Valid:     false,
		SizeText:  core.FormatSize(0),
		Bitrate:   "-",
		CheckedAt: time.Now(),
	}
}

func qualityBitrate(size int64, duration int) (string, int) {
	if size <= 0 || duration <= 0 {
		return "-", 0
	}
	kbps := int((size * 8) / int64(duration) / 1000)
	if kbps <= 0 {
		return "-", 0
	}
	return fmt.Sprintf("%d kbps", kbps), kbps
}

func qualityResultPayload(result qualityInspectResult) gin.H {
	return gin.H{
		"valid":       result.Valid,
		"url":         result.URL,
		"size":        result.SizeText,
		"size_bytes":  result.SizeBytes,
		"bitrate":     result.Bitrate,
		"bitrate_num": result.BitrateNum,
		"cached":      result.Cached,
		"checked_at":  result.CheckedAt,
	}
}

func getCachedQuality(song model.Track, duration int) (qualityInspectResult, bool) {
	currentDB := db
	if currentDB == nil || isLocalMusicSource(song.Source) {
		return qualityInspectResult{}, false
	}
	key, _ := qualityCacheKey(song)
	if key == "" {
		return qualityInspectResult{}, false
	}
	var row qualityCacheRow
	if err := currentDB.Where("key = ?", key).Limit(1).Find(&row).Error; err != nil || row.Key == "" {
		return qualityInspectResult{}, false
	}
	ttl := qualityCacheValidTTL
	if !row.Valid {
		ttl = qualityCacheInvalidTTL
	}
	if time.Since(row.CheckedAt) > ttl {
		currentDB.Where("key = ?", key).Delete(&qualityCacheRow{})
		return qualityInspectResult{}, false
	}

	if row.Valid && row.SizeBytes > 0 && row.BitrateNum == 0 && duration > 0 {
		row.Bitrate, row.BitrateNum = qualityBitrate(row.SizeBytes, duration)
		_ = currentDB.Model(&qualityCacheRow{}).Where("key = ?", key).Updates(map[string]interface{}{
			"bitrate":     row.Bitrate,
			"bitrate_num": row.BitrateNum,
		}).Error
	}

	return qualityInspectResult{
		Valid:      row.Valid,
		URL:        row.URL,
		SizeBytes:  row.SizeBytes,
		SizeText:   row.SizeText,
		Bitrate:    row.Bitrate,
		BitrateNum: row.BitrateNum,
		Cached:     true,
		CheckedAt:  row.CheckedAt,
	}, true
}

func putQualityCache(song model.Track, result qualityInspectResult) {
	currentDB := db
	if currentDB == nil || isLocalMusicSource(song.Source) {
		return
	}
	key, extraHash := qualityCacheKey(song)
	if key == "" {
		return
	}
	if result.CheckedAt.IsZero() {
		result.CheckedAt = time.Now()
	}
	if result.SizeText == "" {
		result.SizeText = core.FormatSize(result.SizeBytes)
	}
	if result.Bitrate == "" {
		result.Bitrate = "-"
	}
	row := qualityCacheRow{
		Key:        key,
		SongID:     strings.TrimSpace(song.ID),
		Source:     strings.TrimSpace(song.Source),
		ExtraHash:  extraHash,
		Valid:      result.Valid,
		URL:        result.URL,
		SizeBytes:  result.SizeBytes,
		SizeText:   result.SizeText,
		Bitrate:    result.Bitrate,
		BitrateNum: result.BitrateNum,
		CheckedAt:  result.CheckedAt,
	}
	if err := currentDB.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"song_id", "source", "extra_hash", "valid", "url",
			"size_bytes", "size_text", "bitrate", "bitrate_num", "checked_at",
		}),
	}).Create(&row).Error; err != nil {
		return
	}
	maybeGCQualityCache(currentDB)
}

func markQualityCacheInvalid(song model.Track) {
	result := qualityInvalidResult()
	result.CheckedAt = time.Now()
	putQualityCache(song, result)
}

// warmQualityCache 预热一批歌曲的音质缓存。
//
// 关键点:「哪些已经缓存过」的判断必须在**请求路径外**完成,而且不能逐首点查。
// 改造前这里是 for 循环里对每首歌调一次 getCachedQuality(单行点查)——
// 163 首的歌单就是 163 次 SQL 之后才把 goroutine 起起来,这段时间完全计入用户请求延迟。
// 现在改成一次 IN 批量查询(按 500 分块,远低于 sqlite 999 / postgres 65535 的绑定参数上限),
// 查询数从 O(歌曲数) 降到 O(1)。
//
// 真实探测(打上游取 size/bitrate)仍然只在后台 goroutine 里做,6 并发上限与
// qualityWarmInFlight 的 in-flight 去重语义保持不变。
func warmQualityCache(songs []model.Track, concurrency int) {
	currentDB := db
	if currentDB == nil || len(songs) == 0 {
		return
	}
	if concurrency <= 0 {
		concurrency = 6
	}
	if concurrency > 6 {
		concurrency = 6
	}
	candidates := make([]warmQualityCandidate, 0, len(songs))
	keys := make([]string, 0, len(songs))
	seen := make(map[string]bool)
	for _, song := range songs {
		if isLocalMusicSource(song.Source) {
			continue
		}
		key, _ := qualityCacheKey(song)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		candidates = append(candidates, warmQualityCandidate{song: song, key: key})
		keys = append(keys, key)
	}
	if len(candidates) == 0 {
		return
	}
	// 一次(分块)批量判断已缓存,替代逐首点查。
	cachedKeys := cachedQualityKeys(currentDB, keys)
	list := make([]model.Track, 0, len(candidates))
	for _, candidate := range candidates {
		if _, ok := cachedKeys[candidate.key]; ok {
			continue
		}
		list = append(list, candidate.song)
	}
	if len(list) == 0 {
		return
	}

	go func() {
		jobs := make(chan model.Track)
		var wg sync.WaitGroup
		for i := 0; i < concurrency; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for song := range jobs {
					key, _ := qualityCacheKey(song)
					if key == "" {
						continue
					}
					if _, loaded := qualityWarmInFlight.LoadOrStore(key, struct{}{}); loaded {
						continue
					}
					_ = inspectSongQualityCached(song, song.Duration)
					qualityWarmInFlight.Delete(key)
				}
			}()
		}
		for _, song := range list {
			jobs <- song
		}
		close(jobs)
		wg.Wait()
	}()
}

type warmQualityCandidate struct {
	song model.Track
	key  string
}

// warmQualityCacheChunkSize 是 IN 查询的每块 key 数。500 对 sqlite(999 绑定参数上限)
// 与 postgres(65535)都安全。
const warmQualityCacheChunkSize = 500

// cachedQualityKeys 批量返回仍然有效的音质缓存 key(有效期内)。
// 与 getCachedQuality 的 TTL 判定保持一致(valid 7 天 / invalid 1 小时),
// 但只读不写:过期行的清理仍由 getCachedQuality / maybeGCQualityCache 负责。
func cachedQualityKeys(currentDB *gorm.DB, keys []string) map[string]struct{} {
	result := make(map[string]struct{}, len(keys))
	now := time.Now()
	for start := 0; start < len(keys); start += warmQualityCacheChunkSize {
		end := start + warmQualityCacheChunkSize
		if end > len(keys) {
			end = len(keys)
		}
		var rows []qualityCacheRow
		if err := currentDB.Model(&qualityCacheRow{}).
			Select("key", "valid", "checked_at").
			Where("key IN ?", keys[start:end]).
			Find(&rows).Error; err != nil {
			// 查询失败时保守返回:当作"全部未缓存",让后台 goroutine 里的
			// inspectSongQualityCached 自己再判一次缓存(它走 getCachedQuality,
			// 命中就不会打上游)。功能安全,只是那一刻不能省下探测。
			continue
		}
		for _, row := range rows {
			ttl := qualityCacheValidTTL
			if !row.Valid {
				ttl = qualityCacheInvalidTTL
			}
			if now.Sub(row.CheckedAt) > ttl {
				continue
			}
			result[row.Key] = struct{}{}
		}
	}
	return result
}

func qualityCacheKey(song model.Track) (string, string) {
	source := strings.TrimSpace(song.Source)
	id := strings.TrimSpace(song.ID)
	if source == "" || id == "" {
		return "", ""
	}
	extraHash := qualityExtraHash(song.Extra)
	credentialHash := core.CookieFingerprintForSource(source)
	raw := strings.Join([]string{strings.ToLower(source), id, extraHash, credentialHash, qualityProbeVersion(source)}, "\x00")
	sum := sha1.Sum([]byte(raw))
	return hex.EncodeToString(sum[:]), extraHash
}

func qualityProbeVersion(source string) string {
	switch strings.ToLower(strings.TrimSpace(source)) {
	case "qq", "qq_wx":
		return qqQualityProbeVersion
	default:
		return ""
	}
}

func qualityExtraHash(extra map[string]string) string {
	if len(extra) == 0 {
		return ""
	}
	keys := make([]string, 0, len(extra))
	for key := range extra {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		k, _ := json.Marshal(key)
		v, _ := json.Marshal(extra[key])
		parts = append(parts, string(k)+":"+string(v))
	}
	raw := "{" + strings.Join(parts, ",") + "}"
	sum := sha1.Sum([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func maybeGCQualityCache(currentDB *gorm.DB) {
	if currentDB == nil {
		return
	}
	qualityCacheGCMu.Lock()
	defer qualityCacheGCMu.Unlock()
	if time.Since(qualityCacheLastGC) < 5*time.Minute {
		return
	}
	qualityCacheLastGC = time.Now()
	if err := currentDB.Where("checked_at < ? AND valid = ?", time.Now().Add(-qualityCacheInvalidTTL), false).Delete(&qualityCacheRow{}).Error; err != nil {
		return
	}

	var n int64
	if currentDB.Model(&qualityCacheRow{}).Count(&n).Error == nil && n > qualityCacheMaxRows {
		var threshold qualityCacheRow
		if err := currentDB.Order("checked_at DESC").Offset(qualityCacheMaxRows - 1).Limit(1).Find(&threshold).Error; err == nil && threshold.Key != "" {
			currentDB.Where("checked_at < ?", threshold.CheckedAt).Delete(&qualityCacheRow{})
		}
	}
}

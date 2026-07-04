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

	"github.com/gin-gonic/gin"
	"github.com/guohuiyuan/go-music-dl/core"
	"github.com/guohuiyuan/music-lib/model"
	"github.com/guohuiyuan/music-lib/soda"
	"gorm.io/gorm/clause"
)

const (
	qualityCacheValidTTL   = 7 * 24 * time.Hour
	qualityCacheInvalidTTL = time.Hour
	qualityCacheMaxRows    = 20000
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

func inspectSongQualityCached(song model.Song, duration int) qualityInspectResult {
	if cached, ok := getCachedQuality(song, duration); ok {
		return cached
	}
	result := inspectSongQuality(song, duration)
	putQualityCache(song, result)
	return result
}

func inspectSongQuality(song model.Song, duration int) qualityInspectResult {
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

func resolveQualityDownloadURL(song model.Song) (string, error) {
	if song.Source == "soda" {
		cookie := core.CM.Get("soda")
		sodaInst := soda.New(cookie)
		info, err := sodaInst.GetDownloadInfo(&model.Song{ID: song.ID, Source: song.Source, Extra: song.Extra})
		if err != nil {
			return "", err
		}
		return info.URL, nil
	}
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

func getCachedQuality(song model.Song, duration int) (qualityInspectResult, bool) {
	if db == nil || isLocalMusicSource(song.Source) {
		return qualityInspectResult{}, false
	}
	key, _ := qualityCacheKey(song)
	if key == "" {
		return qualityInspectResult{}, false
	}
	var row qualityCacheRow
	if err := db.Where("key = ?", key).Limit(1).Find(&row).Error; err != nil || row.Key == "" {
		return qualityInspectResult{}, false
	}
	ttl := qualityCacheValidTTL
	if !row.Valid {
		ttl = qualityCacheInvalidTTL
	}
	if time.Since(row.CheckedAt) > ttl {
		db.Where("key = ?", key).Delete(&qualityCacheRow{})
		return qualityInspectResult{}, false
	}

	if row.Valid && row.SizeBytes > 0 && row.BitrateNum == 0 && duration > 0 {
		row.Bitrate, row.BitrateNum = qualityBitrate(row.SizeBytes, duration)
		_ = db.Model(&qualityCacheRow{}).Where("key = ?", key).Updates(map[string]interface{}{
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

func putQualityCache(song model.Song, result qualityInspectResult) {
	if db == nil || isLocalMusicSource(song.Source) {
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
	_ = db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"song_id", "source", "extra_hash", "valid", "url",
			"size_bytes", "size_text", "bitrate", "bitrate_num", "checked_at",
		}),
	}).Create(&row).Error
	maybeGCQualityCache()
}

func warmQualityCache(songs []model.Song, concurrency int) {
	if db == nil || len(songs) == 0 {
		return
	}
	if concurrency <= 0 {
		concurrency = 6
	}
	if concurrency > 6 {
		concurrency = 6
	}
	list := make([]model.Song, 0, len(songs))
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
		if _, ok := getCachedQuality(song, song.Duration); ok {
			continue
		}
		list = append(list, song)
	}
	if len(list) == 0 {
		return
	}

	go func() {
		jobs := make(chan model.Song)
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

func qualityCacheKey(song model.Song) (string, string) {
	source := strings.TrimSpace(song.Source)
	id := strings.TrimSpace(song.ID)
	if source == "" || id == "" {
		return "", ""
	}
	extraHash := qualityExtraHash(song.Extra)
	raw := strings.Join([]string{strings.ToLower(source), id, extraHash}, "\x00")
	sum := sha1.Sum([]byte(raw))
	return hex.EncodeToString(sum[:]), extraHash
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

func maybeGCQualityCache() {
	qualityCacheGCMu.Lock()
	defer qualityCacheGCMu.Unlock()
	if time.Since(qualityCacheLastGC) < 5*time.Minute {
		return
	}
	qualityCacheLastGC = time.Now()
	db.Where("checked_at < ? AND valid = ?", time.Now().Add(-qualityCacheInvalidTTL), false).Delete(&qualityCacheRow{})

	var n int64
	if db.Model(&qualityCacheRow{}).Count(&n).Error == nil && n > qualityCacheMaxRows {
		var threshold qualityCacheRow
		if err := db.Order("checked_at DESC").Offset(qualityCacheMaxRows - 1).Limit(1).Find(&threshold).Error; err == nil && threshold.Key != "" {
			db.Where("checked_at < ?", threshold.CheckedAt).Delete(&qualityCacheRow{})
		}
	}
}

package web

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/guohuiyuan/go-music-dl/core"
	"github.com/guohuiyuan/music-lib/model"
)

func TestInspectSongQualityCachedPersistsResult(t *testing.T) {
	baseDir := t.TempDir()
	t.Setenv("MUSIC_DL_CONFIG_DB", filepath.Join(baseDir, "data", "settings.db"))
	resetCollectionStateForTest()
	t.Cleanup(resetCollectionStateForTest)
	InitDB()

	const sizeBytes = int64(4_000_000)
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-1/%d", sizeBytes))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte{0, 1})
	}))
	defer server.Close()

	origProvider := qualityDownloadURLProvider
	qualityDownloadURLProvider = func(song model.Song) (string, error) {
		return server.URL + "/track.mp3", nil
	}
	defer func() { qualityDownloadURLProvider = origProvider }()

	song := model.Song{ID: "song-1", Source: "netease", Duration: 100}
	first := inspectSongQualityCached(song, song.Duration)
	if !first.Valid || first.Cached {
		t.Fatalf("first result = %#v, want valid non-cached", first)
	}
	if first.SizeBytes != sizeBytes || first.BitrateNum != 320 {
		t.Fatalf("first quality = size %d bitrate %d, want %d/320", first.SizeBytes, first.BitrateNum, sizeBytes)
	}

	second := inspectSongQualityCached(song, song.Duration)
	if !second.Valid || !second.Cached {
		t.Fatalf("second result = %#v, want valid cached", second)
	}
	if atomic.LoadInt32(&hits) != 1 {
		t.Fatalf("source hit count = %d, want 1", hits)
	}

	var rows int64
	if err := db.Model(&qualityCacheRow{}).Count(&rows).Error; err != nil {
		t.Fatalf("count quality cache rows: %v", err)
	}
	if rows != 1 {
		t.Fatalf("quality cache row count = %d, want 1", rows)
	}
}

func TestCachedQualityRecomputesBitrateWhenDurationArrives(t *testing.T) {
	baseDir := t.TempDir()
	t.Setenv("MUSIC_DL_CONFIG_DB", filepath.Join(baseDir, "data", "settings.db"))
	resetCollectionStateForTest()
	t.Cleanup(resetCollectionStateForTest)
	InitDB()

	song := model.Song{ID: "song-2", Source: "qq"}
	putQualityCache(song, qualityInspectResult{
		Valid:     true,
		SizeBytes: 4_000_000,
		SizeText:  "3.8 MB",
		Bitrate:   "-",
	})

	cached, ok := getCachedQuality(song, 100)
	if !ok || !cached.Cached {
		t.Fatalf("cached result = %#v ok=%v, want cached", cached, ok)
	}
	if cached.BitrateNum != 320 || cached.Bitrate != "320 kbps" {
		t.Fatalf("cached bitrate = %q/%d, want 320 kbps/320", cached.Bitrate, cached.BitrateNum)
	}
}

func TestQualityCacheKeyIncludesCookieFingerprint(t *testing.T) {
	baseDir := t.TempDir()
	t.Setenv("MUSIC_DL_CONFIG_DB", filepath.Join(baseDir, "data", "settings.db"))
	resetCollectionStateForTest()
	t.Cleanup(resetCollectionStateForTest)
	InitDB()

	const sizeBytes = int64(4_000_000)
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-1/%d", sizeBytes))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte{0, 1})
	}))
	defer server.Close()

	origProvider := qualityDownloadURLProvider
	qualityDownloadURLProvider = func(song model.Song) (string, error) {
		return server.URL + "/track.mp3", nil
	}
	defer func() { qualityDownloadURLProvider = origProvider }()

	song := model.Song{ID: "002xpBxA13oPjq", Source: "qq", Duration: 100}
	core.CM.SetAll(map[string]string{"qq": "qqmusic_uin=123456; qm_keyst=FIRST"})
	first := inspectSongQualityCached(song, song.Duration)
	if !first.Valid || first.Cached {
		t.Fatalf("first result = %#v, want valid non-cached", first)
	}

	second := inspectSongQualityCached(song, song.Duration)
	if !second.Valid || !second.Cached {
		t.Fatalf("second result = %#v, want cached for same cookie", second)
	}

	core.CM.SetAll(map[string]string{"qq": "qqmusic_uin=123456; qm_keyst=SECOND"})
	third := inspectSongQualityCached(song, song.Duration)
	if !third.Valid || third.Cached {
		t.Fatalf("third result = %#v, want non-cached after cookie changes", third)
	}
	if atomic.LoadInt32(&hits) != 2 {
		t.Fatalf("source hit count = %d, want 2", hits)
	}
}

func TestQualityCacheKeySkipsLegacyQQProbeCache(t *testing.T) {
	baseDir := t.TempDir()
	t.Setenv("MUSIC_DL_CONFIG_DB", filepath.Join(baseDir, "data", "settings.db"))
	resetCollectionStateForTest()
	t.Cleanup(resetCollectionStateForTest)
	InitDB()

	const sizeBytes = int64(4_000_000)
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-1/%d", sizeBytes))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte{0, 1})
	}))
	defer server.Close()

	origProvider := qualityDownloadURLProvider
	qualityDownloadURLProvider = func(song model.Song) (string, error) {
		return server.URL + "/track.mp3", nil
	}
	defer func() { qualityDownloadURLProvider = origProvider }()

	song := model.Song{ID: "002t0xbC4DCGdE", Source: "qq", Duration: 100, Extra: map[string]string{"songmid": "002t0xbC4DCGdE"}}
	core.CM.SetAll(map[string]string{"qq": "qqmusic_uin=123456; qm_keyst=FIRST"})

	oldKey, extraHash := legacyQualityCacheKeyForTest(song)
	newKey, _ := qualityCacheKey(song)
	if oldKey == newKey {
		t.Fatal("legacy and current QQ quality cache keys should differ after probe upgrade")
	}

	if err := db.Create(&qualityCacheRow{
		Key:       oldKey,
		SongID:    song.ID,
		Source:    song.Source,
		ExtraHash: extraHash,
		Valid:     false,
		SizeText:  "-",
		Bitrate:   "-",
		CheckedAt: time.Now(),
	}).Error; err != nil {
		t.Fatalf("seed legacy quality cache row: %v", err)
	}

	result := inspectSongQualityCached(song, song.Duration)
	if !result.Valid || result.Cached {
		t.Fatalf("result = %#v, want fresh valid result instead of legacy invalid cache", result)
	}
	if atomic.LoadInt32(&hits) != 1 {
		t.Fatalf("source hit count = %d, want 1", hits)
	}
}

func TestMarkQualityCacheInvalidOverwritesCachedValid(t *testing.T) {
	baseDir := t.TempDir()
	t.Setenv("MUSIC_DL_CONFIG_DB", filepath.Join(baseDir, "data", "settings.db"))
	resetCollectionStateForTest()
	t.Cleanup(resetCollectionStateForTest)
	InitDB()

	song := model.Song{ID: "002xpBxA13oPjq", Source: "qq", Duration: 100}
	core.CM.SetAll(map[string]string{"qq": "qqmusic_uin=123456; qm_keyst=FIRST"})
	putQualityCache(song, qualityInspectResult{
		Valid:      true,
		URL:        "https://example.test/audio.flac",
		SizeBytes:  4_000_000,
		SizeText:   "3.8 MB",
		Bitrate:    "320 kbps",
		BitrateNum: 320,
	})

	cached, ok := getCachedQuality(song, song.Duration)
	if !ok || !cached.Valid {
		t.Fatalf("cached result = %#v ok=%v, want valid cache before invalidation", cached, ok)
	}

	markQualityCacheInvalid(song)

	cached, ok = getCachedQuality(song, song.Duration)
	if !ok || cached.Valid {
		t.Fatalf("cached result = %#v ok=%v, want invalid cache after invalidation", cached, ok)
	}
}

func legacyQualityCacheKeyForTest(song model.Song) (string, string) {
	source := strings.TrimSpace(song.Source)
	id := strings.TrimSpace(song.ID)
	if source == "" || id == "" {
		return "", ""
	}
	extraHash := qualityExtraHash(song.Extra)
	credentialHash := core.CookieFingerprintForSource(source)
	raw := strings.Join([]string{strings.ToLower(source), id, extraHash, credentialHash}, "\x00")
	sum := sha1.Sum([]byte(raw))
	return hex.EncodeToString(sum[:]), extraHash
}

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

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
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
	qualityDownloadURLProvider = func(song model.Track) (string, error) {
		return server.URL + "/track.mp3", nil
	}
	defer func() { qualityDownloadURLProvider = origProvider }()

	song := model.Track{ID: "song-1", Source: "netease", Duration: 100}
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

	song := model.Track{ID: "song-2", Source: "qq"}
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
	qualityDownloadURLProvider = func(song model.Track) (string, error) {
		return server.URL + "/track.mp3", nil
	}
	defer func() { qualityDownloadURLProvider = origProvider }()

	song := model.Track{ID: "002xpBxA13oPjq", Source: "qq", Duration: 100}
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
	qualityDownloadURLProvider = func(song model.Track) (string, error) {
		return server.URL + "/track.mp3", nil
	}
	defer func() { qualityDownloadURLProvider = origProvider }()

	song := model.Track{ID: "002t0xbC4DCGdE", Source: "qq", Duration: 100, Extra: map[string]string{"songmid": "002t0xbC4DCGdE"}}
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

	song := model.Track{ID: "002xpBxA13oPjq", Source: "qq", Duration: 100}
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

func legacyQualityCacheKeyForTest(song model.Track) (string, string) {
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

// TestQualityExtraHashIgnoresPresentationOnlyFields 锁住"展示型字段不得冲掉音质缓存"。
//
// 回归背景(2026-11):给搜索结果的 extra 加副歌点位(chorus_start_ms / chorus_end_ms)时,
// qualityExtraHash 原本把 extra 里**所有**键都算进 quality_cache 主键, 于是新增两个与取址
// 完全无关的字段 = 整库音质缓存一次性失效, 下次打开歌单会对每首歌重新打上游探测。
// 这条断言要求:只有展示型字段不同时, 音质缓存 key 必须完全一致。
func TestQualityExtraHashIgnoresPresentationOnlyFields(t *testing.T) {
	base := model.Track{
		ID:     "002t0xbC4DCGdE",
		Source: "qq",
		Extra:  map[string]string{"songmid": "002t0xbC4DCGdE"},
	}
	withChorus := model.Track{
		ID:     "002t0xbC4DCGdE",
		Source: "qq",
		Extra: map[string]string{
			"songmid":         "002t0xbC4DCGdE",
			"chorus_start_ms": "84498",
			"chorus_end_ms":   "142301",
			"provider":        "charles-musicdl",
			"_rank":           "3",
		},
	}

	baseKey, baseExtraHash := qualityCacheKey(base)
	chorusKey, chorusExtraHash := qualityCacheKey(withChorus)
	if baseExtraHash != chorusExtraHash {
		t.Fatalf("extra hash changed by presentation-only fields: %q vs %q", baseExtraHash, chorusExtraHash)
	}
	if baseKey != chorusKey {
		t.Fatalf("quality cache key changed by presentation-only fields: %q vs %q", baseKey, chorusKey)
	}

	// 反向锁:真正影响取址的字段必须仍然改变 key,否则白名单写漏了会串缓存。
	moved := model.Track{
		ID:     "002t0xbC4DCGdE",
		Source: "qq",
		Extra:  map[string]string{"songmid": "different-mid"},
	}
	movedKey, _ := qualityCacheKey(moved)
	if movedKey == baseKey {
		t.Fatal("songmid change must change the quality cache key")
	}
}

// 没有歌名的曲目不得进入后台预热。
//
// 2026-11 真实事故: 歌单预热拿到的 model.Track 只有 ID/Source(载荷侧漏了 Name/Artist),
// 于是预热的 97 首歌每一首都去上游取一次地址, 而取址的兜底搜索词退化成纯数字歌曲 ID。
// 连续 79 次纯数字搜索后网易回 code=405 全域限流, 连「腐草为萤」这种正常歌曲都播不了。
//
// 这条断言锁住"第二道防线": 即使将来某个调用点又忘了带歌名, 预热也不会把它打出去。
func TestWarmQualityCacheSkipsTracksWithoutName(t *testing.T) {
	baseDir := t.TempDir()
	t.Setenv("MUSIC_DL_CONFIG_DB", filepath.Join(baseDir, "data", "settings.db"))
	resetCollectionStateForTest()
	t.Cleanup(resetCollectionStateForTest)
	InitDB()

	var probes int32
	origProvider := qualityDownloadURLProvider
	qualityDownloadURLProvider = func(song model.Track) (string, error) {
		atomic.AddInt32(&probes, 1)
		return "", nil
	}
	t.Cleanup(func() { qualityDownloadURLProvider = origProvider })

	// 缺歌名的(正是事故现场那个形状) + 一首正常的, 用来证明"跳过"是精确的而不是全跳过。
	warmQualityCache([]model.Track{
		{ID: "28188426", Source: "netease", Duration: 280},
		{ID: "28188427", Source: "netease", Name: "棠梨煎雪", Artist: "银临", Duration: 280},
	}, 6)

	// 预热是异步的: 等到探测真的发生(或有界超时才判负), 不做裸 sleep。
	deadline := time.Now().Add(5 * time.Second)
	for atomic.LoadInt32(&probes) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := atomic.LoadInt32(&probes); got == 0 {
		t.Fatal("有歌名的曲目应当被预热探测 —— 这条断言依赖预热真的跑起来")
	}

	// 再等一会儿, 确认缺歌名的那首始终没被探测。
	time.Sleep(200 * time.Millisecond)

	var rows []qualityCacheRow
	if err := db.Where("source = ?", "netease").Find(&rows).Error; err != nil {
		t.Fatalf("read quality cache rows: %v", err)
	}
	for _, row := range rows {
		if row.SongID == "28188426" {
			t.Fatalf("缺歌名的曲目被送进上游探测了 —— 这正是把网易打成限流的那条路")
		}
	}
}

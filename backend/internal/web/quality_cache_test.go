package web

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"

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

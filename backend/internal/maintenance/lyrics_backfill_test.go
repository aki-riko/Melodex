package maintenance

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/guohuiyuan/music-lib/model"
	"gorm.io/gorm"
)

func TestBackfillLyricsDryRunDeduplicatesOwners(t *testing.T) {
	db := openLyricsBackfillTestDB(t)
	downloadDir := t.TempDir()
	writeTestAudio(t, downloadDir, "春信迟 - 婴戏浅戈.flac")
	insertDownloadRecords(t, db,
		downloadRecord{UserID: 1, RelPath: "春信迟 - 婴戏浅戈.flac", Source: "qq", SongID: "00498DKO1STwWZ", Name: "春信迟", Artist: "婴戏浅戈"},
		downloadRecord{UserID: 2, RelPath: "春信迟 - 婴戏浅戈.flac", Source: "qq", SongID: "00498DKO1STwWZ", Name: "春信迟", Artist: "婴戏浅戈"},
	)
	fetches := 0
	summary, err := BackfillLyrics(context.Background(), db, LyricsBackfillOptions{
		DownloadDir: downloadDir,
		DryRun:      true,
		FetchLyric: func(source string, song *model.Song) (string, error) {
			fetches++
			if song.Duration != 274 {
				t.Fatalf("song duration=%d want=274", song.Duration)
			}
			return "[00:01.00]如初见你从桥边折枝缓缓来", nil
		},
		ReadEmbeddedLyric: noEmbeddedLyrics,
		ReadDuration:      func(string) (int, error) { return 274, nil },
	})
	if err != nil {
		t.Fatalf("BackfillLyrics: %v", err)
	}
	if summary.Inspected != 1 || summary.Matched != 1 || summary.Written != 0 || fetches != 1 {
		t.Fatalf("unexpected summary=%+v fetches=%d", summary, fetches)
	}
	assertNoSidecar(t, downloadDir, "春信迟 - 婴戏浅戈.lrc")
}

func TestBackfillLyricsWritesSidecarAndReportsMetadataWarning(t *testing.T) {
	db := openLyricsBackfillTestDB(t)
	downloadDir := t.TempDir()
	writeTestAudio(t, downloadDir, "song.flac")
	insertDownloadRecords(t, db, downloadRecord{UserID: 1, RelPath: "song.flac", Source: "qq", SongID: "song-mid"})
	var output bytes.Buffer
	summary, err := BackfillLyrics(context.Background(), db, LyricsBackfillOptions{
		DownloadDir: downloadDir,
		Output:      &output,
		FetchLyric: func(source string, song *model.Song) (string, error) {
			return "[00:01.00]第一句\r\n[00:02.00]第二句", nil
		},
		ReadEmbeddedLyric: func(string) (string, error) {
			return "", errors.New("unsupported test metadata")
		},
		ReadDuration: noAudioDuration,
	})
	if err != nil {
		t.Fatalf("BackfillLyrics: %v", err)
	}
	if summary.Written != 1 || summary.Matched != 1 {
		t.Fatalf("unexpected summary=%+v", summary)
	}
	data, err := os.ReadFile(filepath.Join(downloadDir, "song.lrc"))
	if err != nil {
		t.Fatalf("read sidecar: %v", err)
	}
	if got, want := string(data), "[00:01.00]第一句\n[00:02.00]第二句\n"; got != want {
		t.Fatalf("sidecar=%q want=%q", got, want)
	}
	if !strings.Contains(output.String(), "WARN metadata") || !strings.Contains(output.String(), "WRITTEN") {
		t.Fatalf("missing audit output: %s", output.String())
	}
}

func TestBackfillLyricsSkipsExistingLyrics(t *testing.T) {
	db := openLyricsBackfillTestDB(t)
	downloadDir := t.TempDir()
	writeTestAudio(t, downloadDir, "embedded.flac")
	writeTestAudio(t, downloadDir, "sidecar.flac")
	if err := os.WriteFile(filepath.Join(downloadDir, "sidecar.lrc"), []byte("[00:01.00]已有"), 0644); err != nil {
		t.Fatalf("write sidecar: %v", err)
	}
	insertDownloadRecords(t, db,
		downloadRecord{UserID: 1, RelPath: "embedded.flac", Source: "qq", SongID: "embedded"},
		downloadRecord{UserID: 1, RelPath: "sidecar.flac", Source: "qq", SongID: "sidecar"},
	)
	fetches := 0
	summary, err := BackfillLyrics(context.Background(), db, LyricsBackfillOptions{
		DownloadDir: downloadDir,
		FetchLyric: func(source string, song *model.Song) (string, error) {
			fetches++
			return "[00:01.00]不应请求", nil
		},
		ReadEmbeddedLyric: func(path string) (string, error) {
			if strings.HasSuffix(path, "embedded.flac") {
				return "[00:01.00]内嵌", nil
			}
			return "", nil
		},
	})
	if err != nil {
		t.Fatalf("BackfillLyrics: %v", err)
	}
	if summary.ExistingEmbedded != 1 || summary.ExistingSidecar != 1 || fetches != 0 {
		t.Fatalf("unexpected summary=%+v fetches=%d", summary, fetches)
	}
}

func TestBackfillLyricsRejectsConflictsUnsafePathsAndPlaceholders(t *testing.T) {
	db := openLyricsBackfillTestDB(t)
	downloadDir := t.TempDir()
	writeTestAudio(t, downloadDir, "conflict.flac")
	writeTestAudio(t, downloadDir, "placeholder.flac")
	insertDownloadRecords(t, db,
		downloadRecord{UserID: 1, RelPath: "conflict.flac", Source: "qq", SongID: "one"},
		downloadRecord{UserID: 2, RelPath: "conflict.flac", Source: "netease", SongID: "two"},
		downloadRecord{UserID: 1, RelPath: "missing.flac", Source: "qq", SongID: "missing"},
		downloadRecord{UserID: 1, RelPath: "../escape.flac", Source: "qq", SongID: "escape"},
		downloadRecord{UserID: 1, RelPath: "placeholder.flac", Source: "qq", SongID: "placeholder"},
	)
	summary, err := BackfillLyrics(context.Background(), db, LyricsBackfillOptions{
		DownloadDir: downloadDir,
		FetchLyric: func(source string, song *model.Song) (string, error) {
			return "[00:00.00] 暂无歌词", nil
		},
		ReadEmbeddedLyric: noEmbeddedLyrics,
		ReadDuration:      noAudioDuration,
	})
	if err != nil {
		t.Fatalf("BackfillLyrics: %v", err)
	}
	if summary.Conflicts != 1 || summary.MissingFiles != 1 || summary.InvalidPaths != 1 || summary.UnusableLyrics != 1 {
		t.Fatalf("unexpected summary=%+v", summary)
	}
	assertNoSidecar(t, downloadDir, "placeholder.lrc")
}

func TestDurationFromFFprobeJSON(t *testing.T) {
	tests := []struct {
		name string
		data string
		want int
	}{
		{name: "format", data: `{"format":{"duration":"274.49"}}`, want: 274},
		{name: "stream fallback", data: `{"format":{},"streams":[{"duration":"61.6"}]}`, want: 62},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := durationFromFFprobeJSON([]byte(test.data))
			if err != nil || got != test.want {
				t.Fatalf("duration=%d err=%v want=%d", got, err, test.want)
			}
		})
	}
	if _, err := durationFromFFprobeJSON([]byte(`{"format":{}}`)); err == nil {
		t.Fatal("missing duration should fail")
	}
}

func openLyricsBackfillTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "test.db")), &gorm.Config{})
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("open sql database: %v", err)
	}
	t.Cleanup(func() {
		_ = sqlDB.Close()
	})
	if err := db.AutoMigrate(&downloadRecord{}); err != nil {
		t.Fatalf("migrate database: %v", err)
	}
	return db
}

func insertDownloadRecords(t *testing.T, db *gorm.DB, records ...downloadRecord) {
	t.Helper()
	for index := range records {
		if err := db.Create(&records[index]).Error; err != nil {
			t.Fatalf("create record: %v", err)
		}
	}
}

func writeTestAudio(t *testing.T, downloadDir, relPath string) {
	t.Helper()
	path := filepath.Join(downloadDir, filepath.FromSlash(relPath))
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("create audio dir: %v", err)
	}
	if err := os.WriteFile(path, []byte("test-audio"), 0644); err != nil {
		t.Fatalf("write audio: %v", err)
	}
}

func noEmbeddedLyrics(string) (string, error) { return "", nil }

func noAudioDuration(string) (int, error) { return 0, nil }

func assertNoSidecar(t *testing.T, downloadDir, relPath string) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(downloadDir, relPath)); !os.IsNotExist(err) {
		t.Fatalf("sidecar should not exist: %v", err)
	}
}

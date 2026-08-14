package core

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

func TestAudioSignaturesAndErrorPayloads(t *testing.T) {
	signatures := []struct {
		name string
		data []byte
		ext  string
	}{
		{"flac", []byte{'f', 'L', 'a', 'C', 0}, "flac"},
		{"mp3", []byte{'I', 'D', '3', 4}, "mp3"},
		{"m4a", []byte{0, 0, 0, 0x20, 'f', 't', 'y', 'p', 'M', '4', 'A', ' '}, "m4a"},
		{"wav", []byte{'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'A', 'V', 'E'}, "wav"},
		{"unknown", []byte("not-audio"), ""},
	}
	for _, tc := range signatures {
		t.Run(tc.name, func(t *testing.T) {
			if got := DetectAudioExtBySignature(tc.data); got != tc.ext {
				t.Fatalf("detected extension = %q, want %q", got, tc.ext)
			}
		})
	}

	payloads := []struct {
		name, mime string
		data       []byte
		want       bool
	}{
		{"mp3", "audio/mpeg", []byte{'I', 'D', '3', 4}, true},
		{"flac without mime", "", []byte{'f', 'L', 'a', 'C'}, true},
		{"m4a octet stream", "application/octet-stream", []byte{0, 0, 0, 0x18, 'f', 't', 'y', 'p', 'M', '4', 'A', ' '}, true},
		{"html error", "audio/mpeg", []byte("<!doctype html><html>login</html>"), false},
		{"json error", "audio/mpeg", []byte(`{"error":"expired"}`), false},
		{"plain text", "text/plain", []byte("not-audio"), false},
	}
	for _, tc := range payloads {
		t.Run(tc.name, func(t *testing.T) {
			if got := LooksLikeAudioData(tc.mime, tc.data); got != tc.want {
				t.Fatalf("audio payload detection = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestRangeParsingAndChunkAssembly(t *testing.T) {
	if total, ok := parseContentRangeTotal("bytes 0-3/61520341"); !ok || total != 61520341 {
		t.Fatalf("content range total = %d,%v", total, ok)
	}

	ranges := []struct {
		header     string
		start, end int64
		partial    bool
		valid      bool
	}{
		{"", 0, 99, false, true},
		{"bytes=10-19", 10, 19, true, true},
		{"bytes=90-", 90, 99, true, true},
		{"bytes=-10", 90, 99, true, true},
		{"bytes=10-5", 0, 0, false, false},
		{"items=0-1", 0, 0, false, false},
		{"bytes=0-1,4-5", 0, 0, false, false},
	}
	for _, tc := range ranges {
		start, end, partial, valid := resolveRangeHeader(tc.header, 100)
		if start != tc.start || end != tc.end || partial != tc.partial || valid != tc.valid {
			t.Fatalf("range %q = %d,%d,%v,%v; want %d,%d,%v,%v", tc.header, start, end, partial, valid, tc.start, tc.end, tc.partial, tc.valid)
		}
	}

	for _, size := range []int{20_000, 800_000} {
		t.Run(filepath.Base(time.Duration(size).String()), func(t *testing.T) {
			payload := append([]byte{'f', 'L', 'a', 'C'}, bytes.Repeat([]byte("0123456789abcdef"), size/16)...)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.ServeContent(w, r, "song.flac", time.Unix(1, 0), bytes.NewReader(payload))
			}))
			defer server.Close()
			data, contentType, err := FetchBytesWithMime(server.URL, "netease")
			if err != nil {
				t.Fatalf("fetch media: %v", err)
			}
			if !bytes.Equal(data, payload) || contentType == "" {
				t.Fatalf("assembled media length/type = %d/%q, want %d/non-empty", len(data), contentType, len(payload))
			}
		})
	}
}

func TestDownloadFilenameTemplateAndQualityPolicy(t *testing.T) {
	track := &model.Track{ID: "12345", Source: "netease", Name: "没地址的信", Artist: "阮俊霖", Album: "专辑/测试"}
	cases := []struct{ template, ext, want string }{
		{"", "mp3", "没地址的信 - 阮俊霖.mp3"},
		{"{artist}/{album}/{name}", "flac", filepath.Join("阮俊霖", "专辑_测试", "没地址的信.flac")},
		{"{artist}/{album}/{name} - {artist}.{ext}", "flac", filepath.Join("阮俊霖", "专辑_测试", "没地址的信 - 阮俊霖.flac")},
		{"../{artist}/./{name}.{ext}", "m4a", filepath.Join("阮俊霖", "没地址的信.m4a")},
		{"{source}-{id}-{name}.{ext}", "m4a", "netease-12345-没地址的信.m4a"},
	}
	for _, tc := range cases {
		if got := BuildDownloadFilename(track, tc.ext, tc.template); got != tc.want {
			t.Fatalf("filename for %q = %q, want %q", tc.template, got, tc.want)
		}
	}

	t.Run("nested output", func(t *testing.T) {
		root := t.TempDir()
		want := filepath.Join(root, "artist", "album", "song.flac")
		result, err := saveDownloadedSongToFile(&DownloadedSong{Data: []byte("audio"), Filename: filepath.Join("artist", "album", "song.flac")}, root)
		if err != nil {
			t.Fatalf("save nested output: %v", err)
		}
		data, readErr := os.ReadFile(want)
		if readErr != nil || result.SavedPath != want || string(data) != "audio" {
			t.Fatalf("nested output = %#v, data=%q, err=%v", result, data, readErr)
		}
	})

	t.Run("higher quality wins", func(t *testing.T) {
		root := t.TempDir()
		flacPath := filepath.Join(root, "歌名 - 歌手.flac")
		if err := os.WriteFile(flacPath, []byte("lossless"), 0o644); err != nil {
			t.Fatalf("seed FLAC: %v", err)
		}
		result, err := saveDownloadedSongToFile(&DownloadedSong{Data: []byte("lossy"), Ext: "mp3", Filename: "歌名 - 歌手.mp3"}, root)
		if err != nil {
			t.Fatalf("save lower-quality candidate: %v", err)
		}
		if !result.Skipped || result.SavedPath != flacPath {
			t.Fatalf("lower-quality result = %#v", result)
		}
		if _, err := os.Stat(filepath.Join(root, "歌名 - 歌手.mp3")); !os.IsNotExist(err) {
			t.Fatalf("lower-quality file should not exist: %v", err)
		}
	})

	for _, extField := range []string{"flac", ""} {
		t.Run("upgrade ext="+extField, func(t *testing.T) {
			root := t.TempDir()
			oldPath := filepath.Join(root, "歌名 - 歌手.mp3")
			if err := os.WriteFile(oldPath, []byte("lossy"), 0o644); err != nil {
				t.Fatalf("seed MP3: %v", err)
			}
			result, err := saveDownloadedSongToFile(&DownloadedSong{Data: []byte("lossless"), Ext: extField, Filename: "歌名 - 歌手.flac"}, root)
			if err != nil {
				t.Fatalf("save quality upgrade: %v", err)
			}
			if result.Skipped || len(result.RemovedPaths) != 1 || result.RemovedPaths[0] != oldPath {
				t.Fatalf("quality upgrade result = %#v", result)
			}
			if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
				t.Fatalf("obsolete MP3 should be removed: %v", err)
			}
			if _, err := os.Stat(filepath.Join(root, "歌名 - 歌手.flac")); err != nil {
				t.Fatalf("FLAC replacement missing: %v", err)
			}
		})
	}
}

func TestConfiguredMediaToolMustExist(t *testing.T) {
	root := t.TempDir()
	ffmpegPath := filepath.Join(root, "ffmpeg")
	if err := os.WriteFile(ffmpegPath, []byte("fixture"), 0o755); err != nil {
		t.Fatalf("create media tool fixture: %v", err)
	}
	t.Setenv(ffmpegEnvName, ffmpegPath)
	if got, err := ResolveFFmpegPath(); err != nil || got != ffmpegPath {
		t.Fatalf("resolved FFmpeg = %q, %v; want %q", got, err, ffmpegPath)
	}

	t.Setenv(ffprobeEnvName, filepath.Join(root, "missing-ffprobe"))
	if _, err := ResolveFFprobePath(); err == nil {
		t.Fatal("missing configured FFprobe path was accepted")
	}
}

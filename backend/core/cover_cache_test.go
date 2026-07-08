package core

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestCoverCacheSaveAndLookup(t *testing.T) {
	dir := t.TempDir()
	orig := coverCacheRoot
	coverCacheRoot = func() string { return filepath.Join(dir, "covers") }
	t.Cleanup(func() { coverCacheRoot = orig })

	url := "https://example.com/cover/abc.jpg"

	// 未缓存时查不到。
	if _, ok := coverCacheLookup(url); ok {
		t.Fatal("should not find before save")
	}

	// 落盘后能查到,内容一致,content-type 从扩展名还原。
	saveCoverToCache(url, "image/png", []byte("PNGDATA"))
	path, ok := coverCacheLookup(url)
	if !ok {
		t.Fatal("should find after save")
	}
	if filepath.Ext(path) != ".png" {
		t.Fatalf("expected .png ext, got %s", filepath.Ext(path))
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "PNGDATA" {
		t.Fatalf("cached content mismatch: %q err=%v", data, err)
	}
	if ct := contentTypeFromExt(filepath.Ext(path)); ct != "image/png" {
		t.Fatalf("content-type from ext = %q, want image/png", ct)
	}
}

func TestIsLikelyImage(t *testing.T) {
	jpeg := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0}
	png := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0}
	webp := append([]byte("RIFF"), append([]byte{0, 0, 0, 0}, []byte("WEBP")...)...)
	html := []byte("<!DOCTYPE html><html><body>403 Forbidden</body></html>")

	cases := []struct {
		name string
		ct   string
		data []byte
		want bool
	}{
		{"content-type image even if body odd", "image/jpeg", html, true},
		{"jpeg magic no content-type", "", jpeg, true},
		{"png magic", "", png, true},
		{"webp magic", "", webp, true},
		{"html error page rejected", "text/html", html, false},
		{"html no content-type rejected", "", html, false},
		{"too short rejected", "", []byte{0xFF}, false},
	}
	for _, c := range cases {
		if got := isLikelyImage(c.ct, c.data); got != c.want {
			t.Fatalf("%s: isLikelyImage(%q,...) = %v, want %v", c.name, c.ct, got, c.want)
		}
	}
}

func TestGetCachedCoverDoesNotUseAudioRangeProbe(t *testing.T) {
	dir := t.TempDir()
	orig := coverCacheRoot
	coverCacheRoot = func() string { return filepath.Join(dir, "covers") }
	t.Cleanup(func() { coverCacheRoot = orig })

	image := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xD9}
	var sawRange atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/jpeg")
		if r.Header.Get("Range") != "" {
			sawRange.Store(true)
			w.Header().Set("Content-Range", "bytes 0-13/14")
			w.WriteHeader(http.StatusPartialContent)
			_, _ = w.Write(image)
			return
		}
		_, _ = w.Write(image)
	}))
	t.Cleanup(server.Close)

	data, contentType, err := GetCachedCover(server.URL+"/cover.jpg", "kugou")
	if err != nil {
		t.Fatalf("GetCachedCover returned error: %v", err)
	}
	if sawRange.Load() {
		t.Fatal("cover fetch should not use audio Range probe")
	}
	if contentType != "image/jpeg" {
		t.Fatalf("contentType = %q, want image/jpeg", contentType)
	}
	if string(data) != string(image) {
		t.Fatalf("data mismatch: got %x want %x", data, image)
	}
}

func TestCoverCacheExtMapping(t *testing.T) {
	cases := map[string]string{
		"image/jpeg":               ".jpg",
		"image/png":                ".png",
		"image/webp":               ".webp",
		"image/gif":                ".gif",
		"application/octet-stream": ".jpg",
		"":                         ".jpg",
	}
	for ct, want := range cases {
		if got := coverExtFromContentType(ct); got != want {
			t.Fatalf("coverExtFromContentType(%q) = %q, want %q", ct, got, want)
		}
	}
}

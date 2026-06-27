package core

import (
	"os"
	"path/filepath"
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

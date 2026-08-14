package core

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	providermodel "github.com/guohuiyuan/go-music-dl/internal/provider/model"
)

func TestProviderBridgeSearchDownloadAndLyrics(t *testing.T) {
	resetProviderBridgeStateForTest()
	defer resetProviderBridgeStateForTest()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/v1/search" {
			t.Fatalf("unexpected provider request: %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"songs": []providermodel.Song{{
				ID: "song-1", Source: "qq", Name: "晴天", Artist: "周杰伦",
				URL: "https://media.example.test/audio.flac", Ext: "flac",
				Extra: map[string]string{
					"lyric":            "[00:00.00]晴天",
					"download_headers": `{"X-Provider-Test":"applied"}`,
					"has_lossless":     "1",
				},
			}},
		})
	}))
	defer server.Close()
	t.Setenv(providerBridgeURLEnv, server.URL)

	searchFn := GetSearchFunc("qq")
	if searchFn == nil {
		t.Fatal("GetSearchFunc(qq) returned nil")
	}
	songs, err := searchFn("周杰伦 晴天")
	if err != nil {
		t.Fatal(err)
	}
	if len(songs) != 1 || songs[0].ID != "song-1" {
		t.Fatalf("unexpected songs: %#v", songs)
	}
	if songs[0].URL != "" || songs[0].Extra["lyric"] != "" || songs[0].Extra["download_headers"] != "" {
		t.Fatalf("public song leaked provider media data: %#v", songs[0])
	}
	if songs[0].Extra["provider_lookup"] != "晴天 周杰伦" {
		t.Fatalf("provider_lookup = %q", songs[0].Extra["provider_lookup"])
	}

	downloadFn := GetDownloadFunc("qq")
	urlStr, err := downloadFn(&songs[0])
	if err != nil || urlStr != "https://media.example.test/audio.flac" {
		t.Fatalf("download URL = %q, err = %v", urlStr, err)
	}
	request, err := BuildSourceRequest(http.MethodGet, urlStr, "qq", "bytes=0-1")
	if err != nil {
		t.Fatal(err)
	}
	if request.Header.Get("X-Provider-Test") != "applied" {
		t.Fatalf("provider header = %q", request.Header.Get("X-Provider-Test"))
	}
	lyric, err := GetLyricFunc("qq")(&songs[0])
	if err != nil || lyric != "[00:00.00]晴天" {
		t.Fatalf("lyric = %q, err = %v", lyric, err)
	}
	if calls.Load() != 1 {
		t.Fatalf("provider calls = %d, want cached single call", calls.Load())
	}

	providerSongCache = sync.Map{}
	providerHeaderCache = sync.Map{}
	urlStr, err = downloadFn(&songs[0])
	if err != nil || urlStr == "" {
		t.Fatalf("download fallback URL = %q, err = %v", urlStr, err)
	}
	if calls.Load() != 2 {
		t.Fatalf("provider calls = %d, want fallback re-resolution", calls.Load())
	}
}

func resetProviderBridgeStateForTest() {
	providerBridgeClientMu.Lock()
	providerBridgeClientURL = ""
	providerBridgeClient = nil
	providerBridgeClientMu.Unlock()
	providerSongCache = sync.Map{}
	providerHeaderCache = sync.Map{}
}

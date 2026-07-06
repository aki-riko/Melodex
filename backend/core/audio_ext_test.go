package core

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDetectAudioExtBySignature(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want string
	}{
		{name: "flac", data: []byte{'f', 'L', 'a', 'C', 0x00}, want: "flac"},
		{name: "id3 mp3", data: []byte{'I', 'D', '3', 0x04}, want: "mp3"},
		{name: "m4a ftyp", data: []byte{0x00, 0x00, 0x00, 0x20, 'f', 't', 'y', 'p', 'M', '4', 'A', ' '}, want: "m4a"},
		{name: "wav riff", data: []byte{'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'A', 'V', 'E'}, want: "wav"},
		{name: "unknown", data: []byte("not-audio"), want: ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := DetectAudioExtBySignature(tc.data); got != tc.want {
				t.Fatalf("DetectAudioExtBySignature() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestLooksLikeAudioDataRejectsTextErrors(t *testing.T) {
	tests := []struct {
		name        string
		contentType string
		data        []byte
		want        bool
	}{
		{name: "mp3 signature", contentType: "audio/mpeg", data: []byte{'I', 'D', '3', 0x04}, want: true},
		{name: "flac signature without mime", contentType: "", data: []byte{'f', 'L', 'a', 'C'}, want: true},
		{name: "m4a signature octet stream", contentType: "application/octet-stream", data: []byte{0, 0, 0, 0x18, 'f', 't', 'y', 'p', 'M', '4', 'A', ' '}, want: true},
		{name: "html mislabeled as audio", contentType: "audio/mpeg", data: []byte("<!doctype html><html>login</html>"), want: false},
		{name: "json mislabeled as audio", contentType: "audio/mpeg", data: []byte(`{"error":"expired"}`), want: false},
		{name: "text without audio mime", contentType: "text/plain", data: []byte("not-audio"), want: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := LooksLikeAudioData(tc.contentType, tc.data); got != tc.want {
				t.Fatalf("LooksLikeAudioData() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestParseContentRangeTotal(t *testing.T) {
	total, ok := parseContentRangeTotal("bytes 0-3/61520341")
	if !ok {
		t.Fatal("parseContentRangeTotal() ok = false")
	}
	if total != 61520341 {
		t.Fatalf("parseContentRangeTotal() = %d, want 61520341", total)
	}
}

func TestFetchBytesWithMimeUsesRangeDownload(t *testing.T) {
	payload := append([]byte{'f', 'L', 'a', 'C'}, bytes.Repeat([]byte("audio"), 4096)...)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "song.flac", time.Now(), bytes.NewReader(payload))
	}))
	defer server.Close()

	data, contentType, err := FetchBytesWithMime(server.URL, "netease")
	if err != nil {
		t.Fatalf("FetchBytesWithMime returned error: %v", err)
	}
	if !bytes.Equal(data, payload) {
		t.Fatalf("FetchBytesWithMime data mismatch: got %d bytes want %d", len(data), len(payload))
	}
	if contentType == "" {
		t.Fatal("FetchBytesWithMime returned empty content type")
	}
}

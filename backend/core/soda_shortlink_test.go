package core

import "testing"

const (
	sodaShortPlaylistLink = "https://qishui.douyin.com/s/iQJQNPDh/"
	sodaShortTrackLink    = "https://qishui.douyin.com/s/iQJx6Qo4/"
)

func TestDetectSourceSupportsSodaDouyinShortLinks(t *testing.T) {
	for _, link := range []string{sodaShortPlaylistLink, sodaShortTrackLink} {
		if got := DetectSource(link); got != "soda" {
			t.Fatalf("DetectSource(%q) = %q, want %q", link, got, "soda")
		}
	}

	if parseFn := GetParseFunc("soda"); parseFn != nil {
		t.Fatal("Soda direct-link parsing must not depend on the removed provider")
	}
	if parsePlaylistFn := GetParsePlaylistFunc("soda"); parsePlaylistFn != nil {
		t.Fatal("Soda playlist parsing must not depend on the removed provider")
	}
}

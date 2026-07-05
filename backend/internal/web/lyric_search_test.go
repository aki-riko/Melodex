package web

import (
	"strings"
	"testing"

	"github.com/guohuiyuan/music-lib/model"
)

func TestFilterSongsByLyricKeepsOnlyMatchedSongs(t *testing.T) {
	oldFetch := fetchLyricForSearch
	t.Cleanup(func() { fetchLyricForSearch = oldFetch })

	fetchLyricForSearch = func(song model.Song) (string, error) {
		switch song.ID {
		case "hit":
			return "[00:12.00]爱如潮水将我向你推\n[00:16.00]紧紧跟随", nil
		case "miss":
			return "[00:10.00]完全不相关的一句", nil
		default:
			return "", nil
		}
	}

	songs := []model.Song{
		{ID: "miss", Source: "qq", Name: "Miss"},
		{ID: "hit", Source: "netease", Name: "Hit"},
	}

	got := filterSongsByLyric("爱 如 潮水", songs)
	if len(got) != 1 || got[0].ID != "hit" {
		t.Fatalf("filterSongsByLyric returned %#v, want only hit", got)
	}
	if match := got[0].Extra["lyric_match"]; !strings.Contains(match, "爱如潮水") {
		t.Fatalf("lyric_match = %q, want matched lyric line", match)
	}
}

func TestCompactLyricSearchTextIgnoresTimestampsAndWhitespace(t *testing.T) {
	got := compactLyricSearchText("[00:01.00] Let it   be \n[00:02.00]答案")
	if !strings.Contains(got, "letitbe") || !strings.Contains(got, "答案") {
		t.Fatalf("compactLyricSearchText = %q, want compact searchable text", got)
	}
}

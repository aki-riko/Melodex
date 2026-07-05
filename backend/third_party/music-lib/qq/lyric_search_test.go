package qq

import (
	"strings"
	"testing"

	"github.com/guohuiyuan/music-lib/model"
)

func TestParseQQLyricSearchResponseUsesSongIDDetailAndKeepsLyricMatch(t *testing.T) {
	body := []byte(`{
		"code": 0,
		"data": {
			"lyric": {
				"list": [{
					"songid": 620129581,
					"songmid": "0",
					"songname": "艾辰《错位时空》",
					"albumname": "乐与爱的回音",
					"interval": 232,
					"size128": 3714197,
					"size320": 9284737,
					"sizeflac": 0,
					"singer": [{"name": "谷梁小璇"}],
					"pay": {"payplay": 0, "paytrackprice": 0},
					"lyric": "&lt;strong class=&quot;keyword&quot;&gt;我吹过你吹过的晚风&lt;/strong&gt;&lt;br/&gt;是否看过同样 风景"
				}]
			}
		}
	}`)

	songs, err := parseQQLyricSearchResponse(body, func(songID string) (*model.Song, error) {
		if songID != "620129581" {
			t.Fatalf("detail songID = %q, want 620129581", songID)
		}
		return &model.Song{
			Source:   "qq",
			ID:       "0028ObeV39rujw",
			Name:     "艾辰《错位时空》",
			Artist:   "谷梁小璇",
			Album:    "乐与爱的回音",
			Duration: 232,
			Cover:    "https://example.com/cover.jpg",
			Extra: map[string]string{
				"songmid": "0028ObeV39rujw",
				"song_id": "620129581",
			},
		}, nil
	})
	if err != nil {
		t.Fatalf("parseQQLyricSearchResponse error: %v", err)
	}
	if len(songs) != 1 {
		t.Fatalf("songs len = %d, want 1", len(songs))
	}
	got := songs[0]
	if got.ID != "0028ObeV39rujw" || got.Extra["songmid"] != "0028ObeV39rujw" {
		t.Fatalf("song mid = %q extra=%q, want resolved mid", got.ID, got.Extra["songmid"])
	}
	if got.Name != "艾辰《错位时空》" || got.Artist != "谷梁小璇" {
		t.Fatalf("song = %q/%q, want parsed metadata", got.Name, got.Artist)
	}
	if !strings.Contains(got.Extra["lyric_match"], "我吹过你吹过的晚风") || strings.Contains(got.Extra["lyric_match"], "<strong") {
		t.Fatalf("lyric_match = %q, want cleaned lyric snippet", got.Extra["lyric_match"])
	}
}

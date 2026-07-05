package web

import (
	"testing"

	"github.com/guohuiyuan/music-lib/model"
)

const (
	lyricOriginalArtist = "\u827e\u8fb0"
	lyricOriginalTitle  = "\u9519\u4f4d\u65f6\u7a7a"
	lyricCoverArtist    = "\u8c37\u6881\u5c0f\u7487"
)

func TestAugmentLyricSearchOriginalsPromotesInferredOriginal(t *testing.T) {
	lyricHit := model.Song{
		Source: "qq",
		ID:     "cover-mid",
		Name:   "艾辰《错位时空》",
		Artist: "谷梁小璇",
		Extra: map[string]string{
			"_rank":        "0",
			"lyric_match":  "我吹过你吹过的晚风 / 是否看过同样 风景",
			"search_match": "lyric",
		},
	}

	got := augmentLyricSearchOriginals("qq", []model.Song{lyricHit}, func(keyword string) ([]model.Song, error) {
		if keyword != "错位时空 艾辰" {
			t.Fatalf("keyword = %q, want 错位时空 艾辰", keyword)
		}
		return []model.Song{
			{Name: "艾辰《错位时空》", Artist: "谷梁小璇", ID: "cover-mid"},
			{Name: "错位时空", Artist: "洛天依", ID: "other-mid"},
			{Name: "错位时空", Artist: "艾辰", ID: "original-mid", Extra: map[string]string{"songmid": "original-mid"}},
		}, nil
	})

	if len(got) != 2 {
		t.Fatalf("len = %d, want original + lyric hit", len(got))
	}
	if got[0].Name != "错位时空" || got[0].Artist != "艾辰" || got[0].ID != "original-mid" {
		t.Fatalf("first = %+v, want inferred original", got[0])
	}
	if got[0].Extra["lyric_match"] != lyricHit.Extra["lyric_match"] {
		t.Fatalf("lyric_match = %q, want copied match", got[0].Extra["lyric_match"])
	}
	if got[0].Extra["lyric_inferred_original"] != "1" || got[0].Extra["search_match"] != "lyric" {
		t.Fatalf("extra = %+v, want inferred lyric marker", got[0].Extra)
	}
	if got[1].ID != "cover-mid" {
		t.Fatalf("second = %+v, want original lyric hit kept after inferred original", got[1])
	}
}

func TestAugmentLyricSearchOriginalsKeepsMultiSourceCandidate(t *testing.T) {
	lyricHit := model.Song{
		Source: "qq",
		ID:     "cover-mid",
		Name:   lyricOriginalArtist + "\u300a" + lyricOriginalTitle + "\u300b",
		Artist: lyricCoverArtist,
		Extra: map[string]string{
			"_rank":        "0",
			"lyric_match":  "\u6211\u5439\u8fc7\u4f60\u5439\u8fc7\u7684\u665a\u98ce",
			"search_match": "lyric",
		},
	}

	got := augmentLyricSearchOriginals("qq", []model.Song{lyricHit}, func(keyword string) ([]model.Song, error) {
		want := lyricOriginalTitle + " " + lyricOriginalArtist
		if keyword != want {
			t.Fatalf("keyword = %q, want %q", keyword, want)
		}
		return []model.Song{
			{
				Source: "qq",
				Name:   lyricOriginalTitle,
				Artist: lyricOriginalArtist,
				ID:     "003hk8xl2MJtkA",
			},
			{
				Source: "netease",
				Name:   lyricOriginalTitle,
				Artist: lyricOriginalArtist,
				ID:     "2100630469",
				Extra:  map[string]string{"song_id": "2100630469"},
			},
		}, nil
	})

	if len(got) != 3 {
		t.Fatalf("len = %d, want qq original + netease original + lyric hit", len(got))
	}
	if got[1].Source != "netease" || got[1].ID != "2100630469" {
		t.Fatalf("second = %+v, want netease original source/id preserved", got[1])
	}
	if got[1].Extra["song_id"] != "2100630469" || got[1].Extra["search_match"] != "lyric" {
		t.Fatalf("extra = %+v, want original extra plus lyric marker", got[1].Extra)
	}
}

func TestAugmentLyricSearchOriginalsSkipsWhenQuotedArtistMatchesSinger(t *testing.T) {
	hit := model.Song{
		Source: "qq",
		ID:     "original-mid",
		Name:   "艾辰《错位时空》",
		Artist: "艾辰",
	}

	called := false
	got := augmentLyricSearchOriginals("qq", []model.Song{hit}, func(keyword string) ([]model.Song, error) {
		called = true
		return nil, nil
	})
	if called {
		t.Fatal("searchFn should not be called when quoted artist already matches singer")
	}
	if len(got) != 1 || got[0].ID != "original-mid" {
		t.Fatalf("got = %+v, want original hit unchanged", got)
	}
}

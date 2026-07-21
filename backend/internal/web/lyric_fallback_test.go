package web

import (
	"errors"
	"testing"

	"github.com/guohuiyuan/music-lib/model"
)

func TestLoadLyricWithFallbackUsesStrictSameSong(t *testing.T) {
	originalLyricProvider := lyricFuncProvider
	originalSearchProvider := switchSearchFuncProvider
	originalDefaults := switchDefaultSourceNames
	originalAll := switchAllSourceNames
	t.Cleanup(func() {
		lyricFuncProvider = originalLyricProvider
		switchSearchFuncProvider = originalSearchProvider
		switchDefaultSourceNames = originalDefaults
		switchAllSourceNames = originalAll
	})

	lyricFuncProvider = func(source string) func(*model.Song) (string, error) {
		switch source {
		case "qq":
			return func(*model.Song) (string, error) { return "", errors.New("qq parse failed") }
		case "netease":
			return func(song *model.Song) (string, error) {
				if song.ID != "2718117658" {
					t.Fatalf("fallback lyric song = %#v", song)
				}
				return "[00:01.53]如初见 你从桥边折枝缓缓来", nil
			}
		default:
			return nil
		}
	}
	switchSearchFuncProvider = func(source string) func(string) ([]model.Song, error) {
		if source != "netease" {
			return nil
		}
		return func(keyword string) ([]model.Song, error) {
			if keyword != "春信迟 婴戏浅戈" {
				t.Fatalf("search keyword = %q", keyword)
			}
			return []model.Song{{
				ID:       "2718117658",
				Source:   "netease",
				Name:     "春信迟",
				Artist:   "婴戏浅戈",
				Duration: 274,
			}}, nil
		}
	}
	switchDefaultSourceNames = func() []string { return []string{"netease"} }
	switchAllSourceNames = func() []string { return nil }

	lyric, matched, err := loadLyricWithFallback(&model.Song{
		ID:       "00498DKO1STwWZ",
		Source:   "qq",
		Name:     "春信迟",
		Artist:   "婴戏浅戈",
		Duration: 274,
	})
	if err != nil {
		t.Fatal(err)
	}
	if matched == nil || matched.Source != "netease" || matched.ID != "2718117658" {
		t.Fatalf("matched song = %#v", matched)
	}
	if lyric != "[00:01.53]如初见 你从桥边折枝缓缓来" {
		t.Fatalf("lyric = %q", lyric)
	}
}

func TestLoadLyricWithFallbackRejectsDifferentDuration(t *testing.T) {
	originalLyricProvider := lyricFuncProvider
	originalSearchProvider := switchSearchFuncProvider
	originalDefaults := switchDefaultSourceNames
	originalAll := switchAllSourceNames
	t.Cleanup(func() {
		lyricFuncProvider = originalLyricProvider
		switchSearchFuncProvider = originalSearchProvider
		switchDefaultSourceNames = originalDefaults
		switchAllSourceNames = originalAll
	})

	lyricFuncProvider = func(source string) func(*model.Song) (string, error) {
		if source == "qq" {
			return func(*model.Song) (string, error) { return "", errors.New("qq failed") }
		}
		return func(*model.Song) (string, error) {
			t.Fatal("mismatched candidate must not fetch lyrics")
			return "", nil
		}
	}
	switchSearchFuncProvider = func(string) func(string) ([]model.Song, error) {
		return func(string) ([]model.Song, error) {
			return []model.Song{{Name: "春信迟", Artist: "婴戏浅戈", Duration: 240}}, nil
		}
	}
	switchDefaultSourceNames = func() []string { return []string{"netease"} }
	switchAllSourceNames = func() []string { return nil }

	lyric, matched, err := loadLyricWithFallback(&model.Song{
		Source: "qq", Name: "春信迟", Artist: "婴戏浅戈", Duration: 274,
	})
	if err == nil {
		t.Fatal("expected fallback error")
	}
	if lyric != "" || matched != nil {
		t.Fatalf("unexpected fallback result lyric=%q matched=%#v", lyric, matched)
	}
}

func TestLoadLyricWithFallbackDoesNotSearchWithIncompleteMetadata(t *testing.T) {
	originalLyricProvider := lyricFuncProvider
	originalSearchProvider := switchSearchFuncProvider
	t.Cleanup(func() {
		lyricFuncProvider = originalLyricProvider
		switchSearchFuncProvider = originalSearchProvider
	})

	lyricFuncProvider = func(source string) func(*model.Song) (string, error) {
		if source == "qq" {
			return func(*model.Song) (string, error) { return "", errors.New("qq failed") }
		}
		return nil
	}
	switchSearchFuncProvider = func(string) func(string) ([]model.Song, error) {
		t.Fatal("incomplete metadata must not trigger fallback search")
		return nil
	}

	lyric, matched, err := loadLyricWithFallback(&model.Song{
		Source: "qq", Name: "春信迟", Duration: 274,
	})
	if err == nil {
		t.Fatal("expected incomplete metadata error")
	}
	if lyric != "" || matched != nil {
		t.Fatalf("unexpected fallback result lyric=%q matched=%#v", lyric, matched)
	}
}

func TestLoadLyricWithFallbackRejectsCandidatesWithIncompleteMetadata(t *testing.T) {
	tests := []struct {
		name      string
		candidate model.Song
	}{
		{
			name: "missing artist",
			candidate: model.Song{
				ID: "missing-artist", Source: "netease", Name: "春信迟", Duration: 274,
			},
		},
		{
			name: "missing duration",
			candidate: model.Song{
				ID: "missing-duration", Source: "netease", Name: "春信迟", Artist: "婴戏浅戈",
			},
		},
		{
			name: "missing song id",
			candidate: model.Song{
				Source: "netease", Name: "春信迟", Artist: "婴戏浅戈", Duration: 274,
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			originalLyricProvider := lyricFuncProvider
			originalSearchProvider := switchSearchFuncProvider
			originalDefaults := switchDefaultSourceNames
			originalAll := switchAllSourceNames
			t.Cleanup(func() {
				lyricFuncProvider = originalLyricProvider
				switchSearchFuncProvider = originalSearchProvider
				switchDefaultSourceNames = originalDefaults
				switchAllSourceNames = originalAll
			})

			fallbackFetches := 0
			lyricFuncProvider = func(source string) func(*model.Song) (string, error) {
				if source == "qq" {
					return func(*model.Song) (string, error) { return "", errors.New("qq failed") }
				}
				return func(*model.Song) (string, error) {
					fallbackFetches++
					return "[00:01.00]不应采用", nil
				}
			}
			switchSearchFuncProvider = func(string) func(string) ([]model.Song, error) {
				return func(string) ([]model.Song, error) {
					return []model.Song{test.candidate}, nil
				}
			}
			switchDefaultSourceNames = func() []string { return []string{"netease"} }
			switchAllSourceNames = func() []string { return nil }

			lyric, matched, err := loadLyricWithFallback(&model.Song{
				Source: "qq", Name: "春信迟", Artist: "婴戏浅戈", Duration: 274,
			})
			if err == nil {
				t.Fatal("expected incomplete candidate metadata error")
			}
			if lyric != "" || matched != nil || fallbackFetches != 0 {
				t.Fatalf("lyric=%q matched=%#v fallbackFetches=%d", lyric, matched, fallbackFetches)
			}
		})
	}
}

func TestLoadLyricWithFallbackTriesLaterStrictCandidate(t *testing.T) {
	originalLyricProvider := lyricFuncProvider
	originalSearchProvider := switchSearchFuncProvider
	originalDefaults := switchDefaultSourceNames
	originalAll := switchAllSourceNames
	t.Cleanup(func() {
		lyricFuncProvider = originalLyricProvider
		switchSearchFuncProvider = originalSearchProvider
		switchDefaultSourceNames = originalDefaults
		switchAllSourceNames = originalAll
	})

	attempted := make([]string, 0, 3)
	lyricFuncProvider = func(source string) func(*model.Song) (string, error) {
		if source == "qq" {
			return func(*model.Song) (string, error) { return "", errors.New("qq failed") }
		}
		return func(song *model.Song) (string, error) {
			attempted = append(attempted, song.ID)
			switch song.ID {
			case "album-version":
				return "", errors.New("album version has no lyric")
			case "empty-version":
				return "", nil
			}
			return "[00:01.00]后续严格候选歌词", nil
		}
	}
	switchSearchFuncProvider = func(string) func(string) ([]model.Song, error) {
		return func(string) ([]model.Song, error) {
			return []model.Song{
				{ID: "album-version", Source: "netease", Name: "春信迟", Artist: "婴戏浅戈", Duration: 274},
				{ID: "empty-version", Source: "netease", Name: "春信迟", Artist: "婴戏浅戈", Duration: 274},
				{ID: "single-version", Source: "netease", Name: "春信迟", Artist: "婴戏浅戈", Duration: 274},
			}, nil
		}
	}
	switchDefaultSourceNames = func() []string { return []string{"netease"} }
	switchAllSourceNames = func() []string { return nil }

	lyric, matched, err := loadLyricWithFallback(&model.Song{
		Source: "qq", Name: "春信迟", Artist: "婴戏浅戈", Duration: 274,
	})
	if err != nil {
		t.Fatal(err)
	}
	if lyric != "[00:01.00]后续严格候选歌词" || matched == nil || matched.ID != "single-version" {
		t.Fatalf("lyric=%q matched=%#v", lyric, matched)
	}
	if len(attempted) != 3 || attempted[0] != "album-version" || attempted[1] != "empty-version" || attempted[2] != "single-version" {
		t.Fatalf("attempted=%v", attempted)
	}
}

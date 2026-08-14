package core

import (
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

func TestProviderCatalogExposesSupportedCollections(t *testing.T) {
	collectionSources := []string{"netease", "qq", "kugou", "kuwo", "migu"}
	if got := GetAlbumSourceNames(); !reflect.DeepEqual(got, collectionSources) {
		t.Fatalf("album sources = %v, want %v", got, collectionSources)
	}
	if got := GetPlaylistSourceNames(); !reflect.DeepEqual(got, collectionSources) {
		t.Fatalf("playlist sources = %v, want %v", got, collectionSources)
	}
	for _, source := range collectionSources {
		if GetAlbumSearchFunc(source) == nil || GetAlbumDetailFunc(source) == nil || GetParseAlbumFunc(source) == nil {
			t.Fatalf("album provider %q is incomplete", source)
		}
		if GetPlaylistSearchFunc(source) == nil || GetPlaylistDetailFunc(source) == nil || GetParsePlaylistFunc(source) == nil {
			t.Fatalf("playlist provider %q is incomplete", source)
		}
	}

	userSources := []string{"netease", "qq"}
	if got := GetUserPlaylistSourceNames(); !reflect.DeepEqual(got, userSources) {
		t.Fatalf("user-playlist sources = %v, want %v", got, userSources)
	}
	for _, source := range userSources {
		if GetUserPlaylistsFunc(source) == nil {
			t.Fatalf("user-playlist provider %q is not wired", source)
		}
	}
}

func TestProviderLinksAndSourceDetection(t *testing.T) {
	linkCases := []struct{ source, id, kind, want string }{
		{"netease", "123", "album", "https://music.163.com/#/album?id=123"},
		{"qq", "abc", "album", "https://y.qq.com/n/ryqq/albumDetail/abc"},
		{"kugou", "456", "album", "https://www.kugou.com/album/456.html"},
		{"kuwo", "789", "album", "http://www.kuwo.cn/album_detail/789"},
		{"migu", "321", "album", "https://music.migu.cn/v3/music/album/321"},
		{"jamendo", "654", "album", "https://www.jamendo.com/album/654"},
		{"joox", "album-id", "album", "https://www.joox.com/hk/album/album-id"},
		{"qianqian", "PS1000000001", "album", "https://music.91q.com/album/PS1000000001"},
		{"soda", "852", "album", "https://www.qishui.com/share/album?album_id=852"},
		{"netease", "123", "playlist", "https://music.163.com/#/playlist?id=123"},
		{"qq", "abc", "playlist", "https://y.qq.com/n/ryqq/playlist/abc"},
		{"kugou", "456", "playlist", "https://www.kugou.com/yy/special/single/456.html"},
		{"kugou", "cloudlist:456", "playlist", ""},
		{"kuwo", "789", "playlist", "http://www.kuwo.cn/playlist_detail/789"},
		{"migu", "321", "playlist", "https://music.migu.cn/v5/#/playlist?playlistId=321&playlistType=ordinary"},
		{"jamendo", "654", "playlist", "https://www.jamendo.com/playlist/654"},
		{"joox", "playlist-id", "playlist", "https://www.joox.com/hk/playlist/playlist-id"},
		{"qianqian", "309319", "playlist", "https://music.91q.com/songlist/309319"},
		{"soda", "852", "playlist", "https://www.qishui.com/playlist/852"},
		{"fivesing", "abc123", "playlist", "http://5sing.kugou.com/dj/abc123.html"},
	}
	for _, tc := range linkCases {
		if got := GetOriginalLink(tc.source, tc.id, tc.kind); got != tc.want {
			t.Fatalf("original link for %s/%s/%s = %q, want %q", tc.source, tc.kind, tc.id, got, tc.want)
		}
	}

	detectCases := []struct{ link, want string }{
		{"https://music.migu.cn/v3/music/album/123", "migu"},
		{"https://www.jamendo.com/album/456", "jamendo"},
		{"https://www.joox.com/hk/album/abc", "joox"},
		{"https://music.91q.com/album/PS0001", "qianqian"},
		{"https://www.qishui.com/share/album?album_id=777", "soda"},
		{"https://qishui.douyin.com/s/iQJQNPDh/", "soda"},
		{"https://qishui.douyin.com/s/iQJx6Qo4/", "soda"},
		{"music.163.com/#/song?id=1", "netease"},
		{"https://example.com/redirect?target=https://music.163.com/song?id=1", ""},
	}
	for _, tc := range detectCases {
		if got := DetectSource(tc.link); got != tc.want {
			t.Fatalf("detected source for %q = %q, want %q", tc.link, got, tc.want)
		}
	}
	if GetParseFunc("soda") != nil || GetParsePlaylistFunc("soda") != nil {
		t.Fatal("Soda short-link detection must not expose unsupported direct parsers")
	}
}

func TestMiguPlaylistProviderIntegration(t *testing.T) {
	if os.Getenv("MELODEX_INTEGRATION") == "" {
		t.Skip("set MELODEX_INTEGRATION=1 to run provider network tests")
	}

	search := GetPlaylistSearchFunc("migu")
	detail := GetPlaylistDetailFunc("migu")
	parse := GetParsePlaylistFunc("migu")
	if search == nil || detail == nil || parse == nil {
		t.Fatal("Migu playlist provider is incomplete")
	}

	type candidate struct{ id, link string }
	candidates := []candidate{{"228114498", "https://music.migu.cn/v5/#/playlist?playlistId=228114498&playlistType=ordinary"}}
	if playlists, err := search("周杰伦"); err == nil {
		for _, playlist := range playlists {
			if playlist.ID != "" {
				candidates = append(candidates, candidate{playlist.ID, playlist.Link})
			}
		}
	} else {
		t.Logf("Migu playlist search unavailable, using fixed public fixture: %v", err)
	}

	var lastErr error
	for _, item := range candidates {
		link := item.link
		if link == "" {
			link = GetOriginalLink("migu", item.id, "playlist")
		}
		if err := verifyPlaylistProvider(item.id, link, detail, parse); err == nil {
			return
		} else {
			lastErr = err
			t.Logf("playlist fixture %q failed: %v", item.id, err)
		}
	}
	t.Fatalf("Migu playlist provider failed all fixtures: %v", lastErr)
}

func verifyPlaylistProvider(id, link string, detail func(string) ([]model.Track, error), parse func(string) (*model.RemoteCollection, []model.Track, error)) error {
	for attempt := 0; attempt < 2; attempt++ {
		tracks, err := detail(id)
		if err == nil && len(tracks) > 0 {
			collection, parsed, parseErr := parse(link)
			if parseErr == nil && collection != nil && collection.ID != "" && len(parsed) > 0 {
				return nil
			}
			if parseErr == nil {
				parseErr = fmt.Errorf("parsed collection is incomplete")
			}
			err = parseErr
		}
		if attempt == 0 {
			time.Sleep(time.Second)
		}
		if err != nil && attempt == 1 {
			return err
		}
	}
	return fmt.Errorf("playlist %q returned no tracks", id)
}

package extensions

import (
	"os"
	"testing"
)

func TestNeteaseAndQQModelMapping(t *testing.T) {
	netease := neteaseSongs([]interface{}{map[string]interface{}{
		"id": float64(1), "name": "晴天", "dt": float64(269000),
		"ar": []interface{}{map[string]interface{}{"name": "周杰伦"}},
		"al": map[string]interface{}{"id": float64(2), "name": "叶惠美", "picUrl": "https://cover.test/1.jpg"},
	}})
	if len(netease) != 1 || netease[0].ID != "1" || netease[0].Duration != 269 || netease[0].AlbumID != "2" {
		t.Fatalf("unexpected netease song: %#v", netease)
	}

	qq := qqSongs([]interface{}{map[string]interface{}{
		"songmid": "mid-1", "songname": "晴天", "interval": float64(269),
		"albummid": "album-1", "albumname": "叶惠美", "sizeflac": float64(123),
		"singer": []interface{}{map[string]interface{}{"name": "周杰伦"}},
	}})
	if len(qq) != 1 || qq[0].ID != "mid-1" || qq[0].Extra["has_lossless"] != "1" {
		t.Fatalf("unexpected qq song: %#v", qq)
	}
	if got := qqCookieUIN("foo=1; uin=o123456; bar=2"); got != "123456" {
		t.Fatalf("qqCookieUIN() = %q", got)
	}
}

func TestLiveNeteasePlaylistFlow(t *testing.T) {
	if os.Getenv("MELODEX_LIVE_EXTENSIONS") != "1" {
		t.Skip("set MELODEX_LIVE_EXTENSIONS=1 to run live platform checks")
	}
	client := NewNetease("")
	playlists, err := client.SearchPlaylist("周杰伦")
	if err != nil || len(playlists) == 0 {
		t.Fatalf("netease search playlists: count=%d err=%v", len(playlists), err)
	}
	playlist, songs, err := client.Playlist(playlists[0].ID)
	if err != nil || playlist == nil || len(songs) == 0 {
		t.Fatalf("netease playlist detail: playlist=%#v songs=%d err=%v", playlist, len(songs), err)
	}
}

func TestLiveQQAlbumFlow(t *testing.T) {
	if os.Getenv("MELODEX_LIVE_EXTENSIONS") != "1" {
		t.Skip("set MELODEX_LIVE_EXTENSIONS=1 to run live platform checks")
	}
	client := NewQQ("")
	albums, err := client.SearchAlbum("周杰伦")
	if err != nil || len(albums) == 0 {
		t.Fatalf("qq search albums: count=%d err=%v", len(albums), err)
	}
	album, songs, err := client.Album(albums[0].ID)
	if err != nil || album == nil || len(songs) == 0 {
		t.Fatalf("qq album detail: album=%#v songs=%d err=%v", album, len(songs), err)
	}
}

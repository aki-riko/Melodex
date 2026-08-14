package extensions

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/guohuiyuan/go-music-dl/internal/provider/model"
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

func TestKugouAndKuwoModelMapping(t *testing.T) {
	kugou := kugouSongs([]interface{}{map[string]interface{}{
		"hash": "ABC123", "filename": "周杰伦 - 晴天", "duration": float64(269),
		"filesize": float64(4304000), "album_id": "960399",
		"trans_param": map[string]interface{}{"union_cover": "http://cover.test/{size}/a.jpg"},
	}})
	if len(kugou) != 1 || kugou[0].Name != "晴天" || kugou[0].Artist != "周杰伦" || kugou[0].Cover != "http://cover.test/240/a.jpg" {
		t.Fatalf("unexpected kugou song: %#v", kugou)
	}

	collection := model.Playlist{ID: "14365066", Name: "叶惠美", Cover: "http://cover.test/album.jpg"}
	kuwo := kuwoSongs([]interface{}{map[string]interface{}{
		"musicrid": "MUSIC_123", "name": "晴天", "artist": "周杰伦", "duration": "269",
	}}, collection)
	if len(kuwo) != 1 || kuwo[0].ID != "123" || kuwo[0].AlbumID != "14365066" || kuwo[0].Cover != collection.Cover {
		t.Fatalf("unexpected kuwo song: %#v", kuwo)
	}
	if id, tagID := parseKugouCategoryID("85:1234"); id != "85" || tagID != "1234" {
		t.Fatalf("parseKugouCategoryID() = %q, %q", id, tagID)
	}
	if matches := kugouPlaylistLinkPattern.FindStringSubmatch("https://www.kugou.com/yy/special/single/6409645.html"); len(matches) != 2 || matches[1] != "6409645" {
		t.Fatalf("unexpected kugou playlist link match: %#v", matches)
	}
	if kugouPlaylistLinkPattern.MatchString("https://www.kugou.com/songlist/gcid_123/") {
		t.Fatal("songlist links must not be treated as specialid links")
	}
}

func TestNormalizeSingleQuotedJSON(t *testing.T) {
	raw := []byte(`{'name':'Don't Stop','quoted':'say "hello"','items':[{'id':'1'}]}`)
	normalized, err := normalizeSingleQuotedJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(normalized, &decoded); err != nil {
		t.Fatalf("normalized payload is invalid: %s: %v", normalized, err)
	}
	if decoded["name"] != "Don't Stop" || decoded["quoted"] != `say "hello"` {
		t.Fatalf("unexpected decoded payload: %#v", decoded)
	}
}

func TestMiguModelMapping(t *testing.T) {
	songs := miguSongs([]interface{}{map[string]interface{}{
		"contentId": "600902000006889366", "copyrightId": "60054701923",
		"songName": "晴天", "duration": float64(270), "albumId": "8592", "album": "叶惠美",
		"img1":       "/data/oss/resource/cover.webp",
		"singerList": []interface{}{map[string]interface{}{"name": "周杰伦"}},
		"audioFormats": []interface{}{map[string]interface{}{
			"resourceType": "E", "formatType": "SQ", "asize": "31529675", "aformat": "011002",
		}},
	}})
	if len(songs) != 1 || songs[0].ID != "600902000006889366" || songs[0].Ext != "flac" || songs[0].Artist != "周杰伦" {
		t.Fatalf("unexpected migu song: %#v", songs)
	}
	if songs[0].Cover != "https://d.musicapp.migu.cn/data/oss/resource/cover.webp" {
		t.Fatalf("unexpected migu cover: %q", songs[0].Cover)
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

func TestLiveKugouPlaylistFlow(t *testing.T) {
	if os.Getenv("MELODEX_LIVE_EXTENSIONS") != "1" {
		t.Skip("set MELODEX_LIVE_EXTENSIONS=1 to run live platform checks")
	}
	client := NewKugou("")
	playlists, err := client.SearchPlaylist("周杰伦")
	if err != nil || len(playlists) == 0 {
		t.Fatalf("kugou search playlists: count=%d err=%v", len(playlists), err)
	}
	playlist, songs, err := client.Playlist(playlists[0].ID)
	if err != nil || playlist == nil || len(songs) == 0 {
		t.Fatalf("kugou playlist detail: playlist=%#v songs=%d err=%v", playlist, len(songs), err)
	}
}

func TestLiveKuwoAlbumFlow(t *testing.T) {
	if os.Getenv("MELODEX_LIVE_EXTENSIONS") != "1" {
		t.Skip("set MELODEX_LIVE_EXTENSIONS=1 to run live platform checks")
	}
	client := NewKuwo("")
	albums, err := client.SearchAlbum("周杰伦")
	if err != nil || len(albums) == 0 {
		t.Fatalf("kuwo search albums: count=%d err=%v", len(albums), err)
	}
	album, songs, err := client.Album(albums[0].ID)
	if err != nil || album == nil || len(songs) == 0 {
		t.Fatalf("kuwo album detail for search result %#v: album=%#v songs=%d err=%v", albums[0], album, len(songs), err)
	}
}

func TestLiveKugouAndKuwoBrowseFlow(t *testing.T) {
	if os.Getenv("MELODEX_LIVE_EXTENSIONS") != "1" {
		t.Skip("set MELODEX_LIVE_EXTENSIONS=1 to run live platform checks")
	}

	kugou := NewKugou("")
	albums, err := kugou.SearchAlbum("周杰伦")
	if err != nil || len(albums) == 0 {
		t.Fatalf("kugou search albums: count=%d err=%v", len(albums), err)
	}
	if _, songs, err := kugou.Album(albums[0].ID); err != nil || len(songs) == 0 {
		t.Fatalf("kugou album detail: songs=%d err=%v", len(songs), err)
	}
	assertBrowseFlow(t, "kugou", kugou.RecommendedPlaylists, kugou.PlaylistCategories, kugou.CategoryPlaylists)

	kuwo := NewKuwo("")
	playlists, err := kuwo.SearchPlaylist("周杰伦")
	if err != nil || len(playlists) == 0 {
		t.Fatalf("kuwo search playlists: count=%d err=%v", len(playlists), err)
	}
	if _, songs, err := kuwo.Playlist(playlists[0].ID); err != nil || len(songs) == 0 {
		t.Fatalf("kuwo playlist detail: songs=%d err=%v", len(songs), err)
	}
	assertBrowseFlow(t, "kuwo", kuwo.RecommendedPlaylists, kuwo.PlaylistCategories, kuwo.CategoryPlaylists)
}

func TestLiveMiguCollectionFlow(t *testing.T) {
	if os.Getenv("MELODEX_LIVE_EXTENSIONS") != "1" {
		t.Skip("set MELODEX_LIVE_EXTENSIONS=1 to run live platform checks")
	}
	client := NewMigu("")
	playlists, err := client.SearchPlaylist("周杰伦")
	if err != nil || len(playlists) == 0 {
		t.Fatalf("migu search playlists: count=%d err=%v", len(playlists), err)
	}
	if playlist, songs, err := client.Playlist(playlists[0].ID); err != nil || playlist == nil || len(songs) == 0 {
		t.Fatalf("migu playlist detail: playlist=%#v songs=%d err=%v", playlist, len(songs), err)
	}

	albums, err := client.SearchAlbum("周杰伦")
	if err != nil || len(albums) == 0 {
		t.Fatalf("migu search albums: count=%d err=%v", len(albums), err)
	}
	foundKnownAlbum := false
	for _, album := range albums {
		if album.ID == "8592" {
			foundKnownAlbum = true
			break
		}
	}
	if !foundKnownAlbum {
		t.Fatal("migu search did not return known album 8592")
	}
	if album, songs, err := client.Album("8592"); err != nil || album == nil || len(songs) == 0 {
		t.Fatalf("migu album detail: album=%#v songs=%d err=%v", album, len(songs), err)
	}
	if playlists, err := client.CategoryPlaylists("华语", 1, 2); err != nil || len(playlists) == 0 {
		t.Fatalf("migu category playlists: count=%d err=%v", len(playlists), err)
	}
}

func assertBrowseFlow(
	t *testing.T,
	source string,
	recommended func() ([]model.Playlist, error),
	categories func() ([]model.PlaylistCategory, error),
	categoryPlaylists func(string, int, int) ([]model.Playlist, error),
) {
	t.Helper()
	if playlists, err := recommended(); err != nil || len(playlists) == 0 {
		t.Fatalf("%s recommendations: count=%d err=%v", source, len(playlists), err)
	}
	values, err := categories()
	if err != nil || len(values) < 2 {
		t.Fatalf("%s categories: count=%d err=%v", source, len(values), err)
	}
	categoryID := values[1].ID
	if source == "kuwo" {
		categoryID = ""
		for _, category := range values {
			if category.ID == "13" {
				categoryID = category.ID
				break
			}
		}
		if categoryID == "" {
			t.Fatal("kuwo live category 13 is missing")
		}
	}
	if playlists, err := categoryPlaylists(categoryID, 1, 2); err != nil || len(playlists) == 0 {
		t.Fatalf("%s category playlists: count=%d err=%v", source, len(playlists), err)
	}
}

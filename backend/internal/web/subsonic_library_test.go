package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/guohuiyuan/music-lib/model"
)

func sampleLibraryTracks() []*localMusicTrack {
	return []*localMusicTrack{
		{ID: encodeLocalMusicID("a.flac"), Name: "晴天", Artist: "周杰伦", Album: "叶惠美", Ext: "flac", Duration: 269},
		{ID: encodeLocalMusicID("b.flac"), Name: "七里香", Artist: "周杰伦", Album: "七里香", Ext: "flac", Duration: 300},
		{ID: encodeLocalMusicID("c.mp3"), Name: "Lemon", Artist: "米津玄師", Album: "Lemon", Ext: "mp3", Duration: 256},
		{ID: encodeLocalMusicID("d.mp3"), Name: "孤独的人", Artist: "", Album: "", Ext: "mp3", Duration: 200},
	}
}

func TestAggregateArtists(t *testing.T) {
	artists := aggregateArtists(sampleLibraryTracks())
	// 周杰伦(2专辑) + 米津玄師(1专辑);空艺人被跳过
	if len(artists) != 2 {
		t.Fatalf("应聚合出 2 个艺人, 实际 %d: %+v", len(artists), artists)
	}
	var jay *subsonicArtist
	for i := range artists {
		if artists[i].Name == "周杰伦" {
			jay = &artists[i]
		}
	}
	if jay == nil || jay.AlbumCount != 2 {
		t.Fatalf("周杰伦应有 2 张专辑: %+v", jay)
	}
	// id 应可解码回名称
	name, ok := decodeNameID(jay.ID)
	if !ok || name != "周杰伦" {
		t.Fatalf("艺人 id 应可解码: %q ok=%v", name, ok)
	}
}

func TestAggregateAlbums(t *testing.T) {
	albums := aggregateAlbums(sampleLibraryTracks())
	// 叶惠美/七里香/Lemon/未知专辑 = 4
	if len(albums) != 4 {
		t.Fatalf("应聚合出 4 张专辑, 实际 %d: %+v", len(albums), albums)
	}
	var unknown bool
	for _, a := range albums {
		if a.Name == "未知专辑" {
			unknown = true
			if a.SongCount != 1 {
				t.Fatalf("未知专辑应含 1 首: %+v", a)
			}
		}
	}
	if !unknown {
		t.Fatal("空专辑名应归到「未知专辑」")
	}
}

func TestBuildIndexes(t *testing.T) {
	artists := aggregateArtists(sampleLibraryTracks())
	indexes := buildIndexes(artists)
	if len(indexes) == 0 {
		t.Fatal("索引不应为空")
	}
	// 每个 index 的首字母分组内艺人非空
	for _, idx := range indexes {
		if len(idx.Artists) == 0 {
			t.Fatalf("索引组 %q 不应为空", idx.Name)
		}
	}
}

func TestLocalTrackToSubsonicChild(t *testing.T) {
	tr := sampleLibraryTracks()[0]
	child := localTrackToSubsonicChild(tr)
	if child.Title != "晴天" || child.Artist != "周杰伦" || child.Suffix != "flac" {
		t.Fatalf("映射错误: %+v", child)
	}
	// id 应是本地前缀且可解码
	if _, ok := decodeLocalSongID(child.ID); !ok {
		t.Fatalf("child.ID 应是合法本地 id: %s", child.ID)
	}
	if child.AlbumID == "" || child.ArtistID == "" {
		t.Fatal("有专辑/艺人时应带合成 id")
	}
}

func TestFetchLyricByIDEmptyAndBad(t *testing.T) {
	if got := fetchLyricByID(""); got != "" {
		t.Fatalf("空 id 应返回空歌词, 实际 %q", got)
	}
	if got := fetchLyricByID("garbage-not-an-id"); got != "" {
		t.Fatalf("非法 id 应返回空歌词, 实际 %q", got)
	}
	// 在线 id 但源无歌词函数 / 无 cookie 环境:不应 panic,返回空。
	song := model.Song{Source: "nonexistent-source", ID: "x", Name: "t", Artist: "a"}
	if got := fetchLyricByID(encodeOnlineSongID(song)); got != "" {
		t.Fatalf("未知源 id 应返回空歌词, 实际 %q", got)
	}
}

func TestSubsonicGetLyricsNoID(t *testing.T) {
	r := newSubsonicTestRouter(t)
	salt := "abcdef"
	token := makeToken("sesame", salt)
	url := "/rest/getLyrics?u=kotori&t=" + token + "&s=" + salt +
		"&v=1.16.1&c=test&f=json&artist=周杰伦&title=晴天"
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	body := rec.Body.String()
	if !strings.Contains(body, "\"status\":\"ok\"") || !strings.Contains(body, "lyrics") {
		t.Fatalf("getLyrics 响应异常: %s", body)
	}
}

func TestSubsonicGetMusicFoldersJSON(t *testing.T) {
	r := newSubsonicTestRouter(t)
	salt := "abcdef"
	token := makeToken("sesame", salt)
	url := "/rest/getMusicFolders?u=kotori&t=" + token + "&s=" + salt + "&v=1.16.1&c=test&f=json"
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, "\"status\":\"ok\"") || !strings.Contains(body, "musicFolder") {
		t.Fatalf("getMusicFolders 响应异常: %s", body)
	}
}

func TestSubsonicGetCoverArtMissingID(t *testing.T) {
	r := newSubsonicTestRouter(t)
	salt := "abcdef"
	token := makeToken("sesame", salt)
	url := "/rest/getCoverArt?u=kotori&t=" + token + "&s=" + salt + "&v=1.16.1&c=test&f=json"
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if !strings.Contains(rec.Body.String(), "\"code\":10") {
		t.Fatalf("缺 id 应返回 code 10: %s", rec.Body.String())
	}
}

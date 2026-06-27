package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/guohuiyuan/music-lib/model"
)

func TestSubsonicGetSongOnline(t *testing.T) {
	r := newSubsonicTestRouter(t)
	salt := "abcdef"
	token := makeToken("sesame", salt)

	// 构造一个在线歌曲 id
	song := model.Song{
		Source: "netease", ID: "42", Name: "稻香", Artist: "周杰伦",
		Album: "魔杰座", Duration: 223, Ext: "mp3", Cover: "http://x/c.jpg",
	}
	id := encodeOnlineSongID(song)

	url := "/rest/getSong?u=kotori&t=" + token + "&s=" + salt +
		"&v=1.16.1&c=test&f=json&id=" + id
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, "\"status\":\"ok\"") {
		t.Fatalf("getSong 应 ok: %s", body)
	}
	if !strings.Contains(body, "稻香") || !strings.Contains(body, "周杰伦") {
		t.Fatalf("getSong 应含歌曲信息: %s", body)
	}
	// coverArt 应非空(播放页据此拉封面)
	if !strings.Contains(body, "coverArt") {
		t.Fatalf("getSong 应含 coverArt: %s", body)
	}
}

func TestSubsonicGetSongBadID(t *testing.T) {
	r := newSubsonicTestRouter(t)
	salt := "abcdef"
	token := makeToken("sesame", salt)
	url := "/rest/getSong?u=kotori&t=" + token + "&s=" + salt +
		"&v=1.16.1&c=test&f=json&id=garbage"
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), "\"code\":70") {
		t.Fatalf("非法 id 应 code 70: %s", rec.Body.String())
	}
}

func TestSubsonicScanStatusAndEmptyOK(t *testing.T) {
	r := newSubsonicTestRouter(t)
	salt := "abcdef"
	token := makeToken("sesame", salt)
	auth := "u=kotori&t=" + token + "&s=" + salt + "&v=1.16.1&c=test&f=json"

	for _, ep := range []string{"getScanStatus", "scrobble", "getPlaylists", "getSimilarSongs", "getRandomSongs"} {
		req := httptest.NewRequest(http.MethodGet, "/rest/"+ep+"?"+auth, nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if !strings.Contains(rec.Body.String(), "\"status\":\"ok\"") {
			t.Fatalf("%s 应返回 ok: %s", ep, rec.Body.String())
		}
	}
}

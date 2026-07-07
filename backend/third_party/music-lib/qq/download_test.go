package qq

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/guohuiyuan/music-lib/model"
	"github.com/guohuiyuan/music-lib/utils"
)

func TestQQCredentialFromCookieFallsBackToZeroUIN(t *testing.T) {
	uin, key := qqCredentialFromCookie("qm_keyst=KEY")
	if uin != "0" {
		t.Fatalf("uin = %q, want 0", uin)
	}
	if key != "KEY" {
		t.Fatalf("key = %q, want KEY", key)
	}
}

func TestGetDownloadURLTriesAuthQualitiesEvenWhenVIPProbeFalse(t *testing.T) {
	origPost := qqMusicuPost
	defer func() { qqMusicuPost = origPost }()

	calls := 0
	qqMusicuPost = func(jsonData []byte, opts ...utils.RequestOption) ([]byte, error) {
		calls++
		if calls != 1 {
			t.Fatalf("unexpected fallback request after authenticated purl, call %d", calls)
		}

		var req map[string]interface{}
		if err := json.Unmarshal(jsonData, &req); err != nil {
			t.Fatalf("request json: %v", err)
		}
		comm, _ := req["comm"].(map[string]interface{})
		if comm["authst"] != "KEY" {
			t.Fatalf("authst = %#v, want KEY", comm["authst"])
		}
		if comm["qq"] != "12345678" {
			t.Fatalf("qq = %#v, want 12345678", comm["qq"])
		}

		req1, _ := req["req_1"].(map[string]interface{})
		param, _ := req1["param"].(map[string]interface{})
		filenames, _ := param["filename"].([]interface{})
		if len(filenames) == 0 || !strings.HasPrefix(filenames[0].(string), "AI00") {
			t.Fatalf("filenames = %#v, want high quality prefixes first", filenames)
		}

		httpReq, _ := http.NewRequest(http.MethodPost, "https://example.invalid", nil)
		for _, opt := range opts {
			opt(httpReq)
		}
		if !strings.Contains(httpReq.Header.Get("Cookie"), "qqmusic_key=KEY") {
			t.Fatalf("Cookie header = %q, want normalized qqmusic_key", httpReq.Header.Get("Cookie"))
		}

		return []byte(`{"req_1":{"data":{"midurlinfo":[{"filename":"F000SONGSONG.flac","purl":"C400SONG.flac"}]}}}`), nil
	}

	vipFalse := false
	q := New("uin=12345678; qm_keyst=KEY")
	q.isVipCache = &vipFalse

	got, err := q.GetDownloadURL(&model.Song{Source: "qq", ID: "SONG"})
	if err != nil {
		t.Fatalf("GetDownloadURL returned error: %v", err)
	}
	if got != "https://ws.stream.qqmusic.qq.com/C400SONG.flac" {
		t.Fatalf("url = %q", got)
	}
}

func TestSearchKeepsPaidTracksWhenMusicKeyPresent(t *testing.T) {
	origGet := qqSearchGet
	defer func() { qqSearchGet = origGet }()

	qqSearchGet = func(apiURL string, opts ...utils.RequestOption) ([]byte, error) {
		if !strings.Contains(apiURL, "search_for_qq_cp") {
			t.Fatalf("apiURL = %q, want qq search endpoint", apiURL)
		}
		httpReq, _ := http.NewRequest(http.MethodGet, "https://example.invalid", nil)
		for _, opt := range opts {
			opt(httpReq)
		}
		if !strings.Contains(httpReq.Header.Get("Cookie"), "qqmusic_key=KEY") {
			t.Fatalf("Cookie header = %q, want normalized qqmusic_key", httpReq.Header.Get("Cookie"))
		}

		return []byte(`{"data":{"song":{"list":[{"songid":1001,"songname":"爱的回归线","songmid":"002xpBxA13oPjq","albumname":"爱情公寓3 电视剧原声带","albummid":"ALBUMMID","interval":257,"size128":4115024,"size320":10287236,"sizeflac":29407460,"singer":[{"name":"陈韵若"},{"name":"陈每文"}],"pay":{"paydownload":1,"payplay":1,"paytrackprice":200}}]}}}`), nil
	}

	vipFalse := false
	q := New("uin=12345678; qm_keyst=KEY")
	q.isVipCache = &vipFalse

	songs, err := q.Search("爱的回归")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(songs) != 1 {
		t.Fatalf("len(songs) = %d, want 1", len(songs))
	}
	if songs[0].ID != "002xpBxA13oPjq" {
		t.Fatalf("song ID = %q", songs[0].ID)
	}
	if songs[0].Extra["is_paid"] != "1" {
		t.Fatalf("is_paid extra = %q, want 1", songs[0].Extra["is_paid"])
	}
	if songs[0].Extra["has_lossless"] != "1" {
		t.Fatalf("has_lossless extra = %q, want 1", songs[0].Extra["has_lossless"])
	}
}

func TestSearchFiltersVIPOnlyTracksWithoutMusicKey(t *testing.T) {
	origGet := qqSearchGet
	defer func() { qqSearchGet = origGet }()

	qqSearchGet = func(apiURL string, opts ...utils.RequestOption) ([]byte, error) {
		return []byte(`{"data":{"song":{"list":[{"songid":1001,"songname":"VIP Only","songmid":"VIPMID","interval":200,"size128":3000000,"singer":[{"name":"Singer"}],"pay":{"paydownload":1,"payplay":1,"paytrackprice":200}},{"songid":1002,"songname":"Free Track","songmid":"FREEMID","interval":180,"size128":2500000,"singer":[{"name":"Singer"}],"pay":{"paydownload":0,"payplay":0,"paytrackprice":0}}]}}}`), nil
	}

	songs, err := New("").Search("爱的回归")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(songs) != 1 {
		t.Fatalf("len(songs) = %d, want 1", len(songs))
	}
	if songs[0].ID != "FREEMID" {
		t.Fatalf("song ID = %q, want FREEMID", songs[0].ID)
	}
}

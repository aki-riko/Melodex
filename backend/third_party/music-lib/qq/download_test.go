package qq

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
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

func TestQQSecurityPostLiveAnonymous(t *testing.T) {
	if os.Getenv("QQ_SECURITY_LIVE") != "1" {
		t.Skip("set QQ_SECURITY_LIVE=1 to run live QQ musics.fcg probe")
	}
	if _, err := qqSecurityNodePath(); err != nil {
		t.Skipf("node unavailable: %v", err)
	}
	t.Setenv("MUSIC_DL_QQ_SECURITY_CACHE_DIR", filepath.Join(t.TempDir(), "qq-security-cache"))

	songMID := "002xpBxA13oPjq"
	reqData := map[string]interface{}{
		"comm": map[string]interface{}{
			"cv":          4747474,
			"ct":          24,
			"format":      "json",
			"inCharset":   "utf-8",
			"outCharset":  "utf-8",
			"notice":      0,
			"platform":    "yqq.json",
			"needNewCode": 1,
			"uin":         "0",
		},
		"req_1": map[string]interface{}{
			"module": "music.vkey.GetVkey",
			"method": "UrlGetVkey",
			"param": map[string]interface{}{
				"guid":      "1234567890",
				"songmid":   []string{songMID},
				"songtype":  []int{0},
				"uin":       "0",
				"loginflag": 1,
				"platform":  "20",
				"filename":  []string{"M500" + songMID + songMID + ".mp3"},
			},
		},
	}
	jsonData, err := json.Marshal(reqData)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}

	body, err := qqSecurityPost(jsonData,
		utils.WithHeader("User-Agent", UserAgent),
		utils.WithHeader("Referer", DownloadReferer),
		utils.WithHeader("Content-Type", "application/json"),
	)
	if err != nil {
		t.Fatalf("qqSecurityPost returned error: %v", err)
	}

	var result struct {
		Code int `json:"code"`
		Req1 struct {
			Code int `json:"code"`
			Data struct {
				Retcode    int `json:"retcode"`
				MidURLInfo []struct {
					Filename string `json:"filename"`
				} `json:"midurlinfo"`
			} `json:"data"`
		} `json:"req_1"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("response json: %v; body=%s", err, string(body))
	}
	if result.Code != 0 || result.Req1.Code != 1000 || result.Req1.Data.Retcode != 104009 {
		t.Fatalf("unexpected response codes: top=%d req_1=%d retcode=%d body=%s", result.Code, result.Req1.Code, result.Req1.Data.Retcode, string(body))
	}
	if len(result.Req1.Data.MidURLInfo) != 1 || result.Req1.Data.MidURLInfo[0].Filename == "" {
		t.Fatalf("midurlinfo missing: %+v", result.Req1.Data.MidURLInfo)
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

func TestSearchUsesNumericSongIDWhenSongMIDIsZero(t *testing.T) {
	origGet := qqSearchGet
	defer func() { qqSearchGet = origGet }()

	qqSearchGet = func(string, ...utils.RequestOption) ([]byte, error) {
		return []byte(`{"data":{"song":{"list":[{"songid":613053895,"songname":"晚安","songmid":"0","albumname":"","albummid":"0","interval":283,"size128":4542135,"singer":[{"name":"许莉洁"}],"pay":{"payplay":0}}]}}}`), nil
	}

	vipFalse := false
	q := New("")
	q.isVipCache = &vipFalse
	songs, err := q.Search("晚安")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(songs) != 1 {
		t.Fatalf("len(songs) = %d, want 1", len(songs))
	}
	got := songs[0]
	if got.ID != "613053895" || got.Extra["songmid"] != "" {
		t.Fatalf("song identity = id:%q extra:%#v", got.ID, got.Extra)
	}
	if got.Cover != "" || got.Link != "" {
		t.Fatalf("song presentation = cover:%q link:%q", got.Cover, got.Link)
	}
}

func TestGetDownloadURLResolvesZeroSongMIDFromNumericSongID(t *testing.T) {
	origDetailGet := qqSongDetailGet
	origPost := qqMusicuPost
	defer func() {
		qqSongDetailGet = origDetailGet
		qqMusicuPost = origPost
	}()

	qqSongDetailGet = func(apiURL string, _ ...utils.RequestOption) ([]byte, error) {
		if !strings.Contains(apiURL, "songid=613053895") {
			t.Fatalf("detail URL = %q", apiURL)
		}
		return []byte(`{"data":[{"id":613053895,"name":"晚安","mid":"000033wK2aPdea","album":{"name":"","mid":""},"singer":[{"name":"许莉洁"}],"interval":283}]}`), nil
	}
	qqMusicuPost = func(jsonData []byte, _ ...utils.RequestOption) ([]byte, error) {
		var request struct {
			Req1 struct {
				Param struct {
					SongMID   []string `json:"songmid"`
					Filenames []string `json:"filename"`
				} `json:"param"`
			} `json:"req_1"`
		}
		if err := json.Unmarshal(jsonData, &request); err != nil {
			t.Fatalf("request json: %v", err)
		}
		if len(request.Req1.Param.SongMID) == 0 || request.Req1.Param.SongMID[0] != "000033wK2aPdea" {
			t.Fatalf("songmid = %#v", request.Req1.Param.SongMID)
		}
		filename := request.Req1.Param.Filenames[0]
		return []byte(fmt.Sprintf(`{"req_1":{"data":{"midurlinfo":[{"filename":%q,"purl":"resolved.mp3"}]}}}`, filename)), nil
	}

	song := &model.Song{Source: "qq", ID: "613053895", Extra: map[string]string{
		"song_id": "613053895", "songmid": "0",
	}}
	got, err := New("").GetDownloadURL(song)
	if err != nil {
		t.Fatalf("GetDownloadURL returned error: %v", err)
	}
	if got != "https://ws.stream.qqmusic.qq.com/resolved.mp3" {
		t.Fatalf("url = %q", got)
	}
	if song.Extra["songmid"] != "000033wK2aPdea" {
		t.Fatalf("resolved extra = %#v", song.Extra)
	}
}

func TestResolveSongMIDLiveForReportedSong(t *testing.T) {
	if os.Getenv("QQ_SONG_DETAIL_LIVE") != "1" {
		t.Skip("set QQ_SONG_DETAIL_LIVE=1 to run the reported QQ song detail probe")
	}
	song := &model.Song{Source: "qq", ID: "0", Extra: map[string]string{
		"song_id": "613053895", "songmid": "0",
	}}
	songMID, err := New("").resolveSongMID(song)
	if err != nil {
		t.Fatalf("resolveSongMID returned error: %v", err)
	}
	if songMID != "000033wK2aPdea" {
		t.Fatalf("songMID = %q, want 000033wK2aPdea", songMID)
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

func TestIsVipAccountReturnsAPIErrorWhenProbeRejected(t *testing.T) {
	origPost := qqVIPPost
	defer func() { qqVIPPost = origPost }()

	qqVIPPost = func(apiURL string, body io.Reader, opts ...utils.RequestOption) ([]byte, error) {
		if !strings.Contains(apiURL, "musicu.fcg") {
			t.Fatalf("apiURL = %q, want musicu.fcg", apiURL)
		}
		return []byte(`{"req_1":{"code":104009,"data":{"midurlinfo":[{"purl":""}]}}}`), nil
	}

	q := New("uin=12345678; qm_keyst=KEY")
	vip, err := q.IsVipAccount()
	if err == nil || !strings.Contains(err.Error(), "104009") {
		t.Fatalf("err = %v, want 104009", err)
	}
	if vip {
		t.Fatal("vip = true, want false")
	}
	if q.isVipCache != nil {
		t.Fatal("rejected probe should not be cached as a conclusive VIP result")
	}
}

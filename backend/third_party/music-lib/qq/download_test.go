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

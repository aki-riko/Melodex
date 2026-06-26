package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNormalizeMatchKey(t *testing.T) {
	cases := map[string]string{
		"  晴天 ":  "晴天",
		"Hello":  "hello",
		"WORLD ": "world",
		"":       "",
		"  ":     "",
	}
	for in, want := range cases {
		if got := normalizeMatchKey(in); got != want {
			t.Fatalf("normalizeMatchKey(%q)=%q, want %q", in, got, want)
		}
	}
}

func TestTriggerBackgroundDownloadDedup(t *testing.T) {
	// 同一 key 第二次 LoadOrStore 应判定为已在下载中(loaded=true),不重复启动。
	key := extraKey("netease", "dedup-test-id")
	downloadInFlight.Delete(key) // 清理可能的残留

	if _, loaded := downloadInFlight.LoadOrStore(key, true); loaded {
		t.Fatal("首次应未加载")
	}
	if _, loaded := downloadInFlight.LoadOrStore(key, true); !loaded {
		t.Fatal("第二次应判定已在下载中(去重生效)")
	}
	downloadInFlight.Delete(key)
}

func TestSubsonicStreamMissingID(t *testing.T) {
	r := newSubsonicTestRouter(t)
	salt := "abcdef"
	token := makeToken("sesame", salt)
	url := "/rest/stream?u=kotori&t=" + token + "&s=" + salt + "&v=1.16.1&c=test&f=json"
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, "\"status\":\"failed\"") || !strings.Contains(body, "\"code\":10") {
		t.Fatalf("缺 id 应返回 code 10: %s", body)
	}
}

func TestSubsonicStreamBadOnlineID(t *testing.T) {
	r := newSubsonicTestRouter(t)
	salt := "abcdef"
	token := makeToken("sesame", salt)
	// 非法 id(既非 loc: 也非 ts1: 合法编码)
	url := "/rest/stream?u=kotori&t=" + token + "&s=" + salt + "&v=1.16.1&c=test&f=json&id=garbage"
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, "\"status\":\"failed\"") || !strings.Contains(body, "\"code\":70") {
		t.Fatalf("非法 id 应返回 code 70: %s", body)
	}
}

package qq

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseQQQRCheckExtractsStrongLoginInputs(t *testing.T) {
	raw := `ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?pttype=1&uin=12345678&service=ptqrlogin&nodirect=0&ptsigx=SIGX+TOKEN&s_url=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump&ptlang=2052&ptredirect=100&aid=716027609&daid=383&j_later=0&low_login_hour=0&regmaster=0&pt_login_type=3&pt_aid=0&pt_aaid=16&pt_light=0&pt_3rd_aid=100497308','0','登录成功！','nickname');`
	code, message, redirectURL, uin, sigx := parseQQQRCheck(raw)
	if code != "0" {
		t.Fatalf("code = %q, want 0", code)
	}
	if message != "登录成功！" {
		t.Fatalf("message = %q", message)
	}
	if redirectURL == "" {
		t.Fatal("redirectURL should not be empty")
	}
	if uin != "12345678" {
		t.Fatalf("uin = %q, want 12345678", uin)
	}
	if sigx != "SIGX+TOKEN" {
		t.Fatalf("sigx = %q, want SIGX+TOKEN", sigx)
	}
}

func TestQQLoginDataCookiesPreservesStrongCredentialFields(t *testing.T) {
	got := qqLoginDataCookies(map[string]interface{}{
		"musicid":            float64(12345678),
		"musickey":           "KEY",
		"refresh_key":        "REFRESH_KEY",
		"refresh_token":      "REFRESH_TOKEN",
		"openid":             "OPENID",
		"unionid":            "UNIONID",
		"access_token":       "ACCESS",
		"musickeyCreateTime": float64(1710000000),
		"keyExpiresIn":       float64(86400),
		"encryptUin":         "E_UIN",
		"loginType":          float64(2),
	})
	want := map[string]string{
		"musicid":                  "12345678",
		"qqmusic_uin":              "12345678",
		"musickey":                 "KEY",
		"qqmusic_key":              "KEY",
		"qm_keyst":                 "KEY",
		"refresh_key":              "REFRESH_KEY",
		"refresh_token":            "REFRESH_TOKEN",
		"openid":                   "OPENID",
		"wxopenid":                 "OPENID",
		"unionid":                  "UNIONID",
		"wxunionid":                "UNIONID",
		"access_token":             "ACCESS",
		"wxaccess_token":           "ACCESS",
		"musickeyCreateTime":       "1710000000",
		"psrf_musickey_createtime": "1710000000",
		"keyExpiresIn":             "86400",
		"encryptUin":               "E_UIN",
		"euin":                     "E_UIN",
		"loginType":                "2",
		"tmeLoginType":             "2",
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("got[%q] = %q, want %q (full map %#v)", k, got[k], v, got)
		}
	}
}

func TestQQCredentialFromCookieUsesStrongFields(t *testing.T) {
	uin, key := qqCredentialFromCookie("qqmusic_uin=12345678; qm_keyst=KEY; qqmusic_key=ALT")
	if uin != "12345678" {
		t.Fatalf("uin = %q, want 12345678", uin)
	}
	if key != "ALT" {
		t.Fatalf("key = %q, want ALT", key)
	}
}

func TestNormalizeQQMusicCookiesBackfillsStrongCredentialAliases(t *testing.T) {
	got := normalizeQQMusicCookies(map[string]string{
		"uin":      "12345678",
		"qm_keyst": "KEY",
	})
	want := map[string]string{
		"uin":         "12345678",
		"musicid":     "12345678",
		"qqmusic_uin": "12345678",
		"musickey":    "KEY",
		"qqmusic_key": "KEY",
		"qm_keyst":    "KEY",
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("got[%q] = %q, want %q (full map %#v)", k, got[k], v, got)
		}
	}
}

func TestNewNormalizesSavedQQStrongCookieAliases(t *testing.T) {
	q := New("uin=12345678; qm_keyst=KEY")
	uin, key := qqCredentialFromCookie(q.cookie)
	if uin != "12345678" {
		t.Fatalf("uin = %q, want 12345678 (cookie %q)", uin, q.cookie)
	}
	if key != "KEY" {
		t.Fatalf("key = %q, want KEY (cookie %q)", key, q.cookie)
	}
	for _, part := range []string{"musicid=12345678", "qqmusic_uin=12345678", "musickey=KEY", "qqmusic_key=KEY", "qm_keyst=KEY"} {
		if !strings.Contains(q.cookie, part) {
			t.Fatalf("normalized cookie %q missing %q", q.cookie, part)
		}
	}
}

func TestNewKeepsEmptyQQCookieEmpty(t *testing.T) {
	if q := New(""); q.cookie != "" {
		t.Fatalf("empty cookie normalized to %q", q.cookie)
	}
}

func TestQQMobileCookieValueAcceptsMultiplePayloadShapes(t *testing.T) {
	cases := []struct {
		name    string
		payload map[string]interface{}
		wantUIN string
		wantKey string
	}{
		{
			name: "map of cookie objects",
			payload: map[string]interface{}{
				"cookies": map[string]interface{}{
					"qqmusic_uin": map[string]interface{}{"value": "12345678"},
					"qqmusic_key": map[string]interface{}{"value": "KEY"},
				},
			},
			wantUIN: "12345678",
			wantKey: "KEY",
		},
		{
			name: "array cookies with aliases",
			payload: map[string]interface{}{
				"cookies": []interface{}{
					map[string]interface{}{"name": "musicid", "value": float64(12345678)},
					map[string]interface{}{"name": "musickey", "value": "KEY"},
				},
			},
			wantUIN: "12345678",
			wantKey: "KEY",
		},
		{
			name: "cookie string inside data",
			payload: map[string]interface{}{
				"data": map[string]interface{}{
					"cookie": "qqmusic_uin=12345678; qm_keyst=KEY",
				},
			},
			wantUIN: "12345678",
			wantKey: "KEY",
		},
		{
			name: "direct credential fields",
			payload: map[string]interface{}{
				"musicid":  float64(12345678),
				"musickey": "KEY",
			},
			wantUIN: "12345678",
			wantKey: "KEY",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			uin := qqMobileCookieValue(tc.payload, "qqmusic_uin", "musicid", "uin")
			key := qqMobileCookieValue(tc.payload, "qqmusic_key", "musickey", "qm_keyst")
			if uin != tc.wantUIN || key != tc.wantKey {
				t.Fatalf("uin/key = %q/%q, want %q/%q", uin, key, tc.wantUIN, tc.wantKey)
			}
		})
	}
}

func TestQQMobileFailureDetailsClassifiesMQTTDeadline(t *testing.T) {
	message, extra := qqMobileFailureDetails(context.DeadlineExceeded, map[string]string{"stage": "mqtt_connect"})
	if !strings.Contains(message, "强登录通道连接超时") {
		t.Fatalf("message = %q, want MQTT timeout hint", message)
	}
	if extra["error_type"] != "network_timeout" {
		t.Fatalf("error_type = %q, want network_timeout (extra %#v)", extra["error_type"], extra)
	}
	if extra["stage"] != "mqtt_connect" {
		t.Fatalf("stage = %q, want mqtt_connect", extra["stage"])
	}
	if extra["last_error"] != context.DeadlineExceeded.Error() {
		t.Fatalf("last_error = %q, want %q", extra["last_error"], context.DeadlineExceeded.Error())
	}
	if !strings.Contains(extra["suggestion"], "mu.y.qq.com:443") {
		t.Fatalf("suggestion = %q, want endpoint hint", extra["suggestion"])
	}
}

func TestCookieNeedsRefreshUsesMusicKeyExpiry(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	cookie := "musicid=12345678; musickey=KEY; refresh_key=REFRESH_KEY; refresh_token=REFRESH_TOKEN; musickeyCreateTime=1699990000; keyExpiresIn=7200"
	if !CookieNeedsRefresh(cookie, now) {
		t.Fatal("CookieNeedsRefresh should refresh inside skew window")
	}

	fresh := "musicid=12345678; musickey=KEY; refresh_key=REFRESH_KEY; refresh_token=REFRESH_TOKEN; musickeyCreateTime=1700000000; keyExpiresIn=7200"
	if CookieNeedsRefresh(fresh, now) {
		t.Fatal("CookieNeedsRefresh should keep fresh cookies")
	}
}

func TestCookieNeedsRefreshRequiresRefreshMaterial(t *testing.T) {
	cookie := "musicid=12345678; musickey=KEY; musickeyCreateTime=1699990000; keyExpiresIn=7200"
	if CookieNeedsRefresh(cookie, time.Unix(1_700_000_000, 0)) {
		t.Fatal("CookieNeedsRefresh should not refresh without refresh_key/refresh_token")
	}
	if CookieRefreshable(cookie) {
		t.Fatal("CookieRefreshable should require refresh_key/refresh_token")
	}
}

func TestParseCookieString(t *testing.T) {
	got := parseCookieString("qrsig=abc; pt_login_sig=def ; empty= ; invalid")
	if got["qrsig"] != "abc" {
		t.Fatalf("qrsig = %q, want abc", got["qrsig"])
	}
	if got["pt_login_sig"] != "def" {
		t.Fatalf("pt_login_sig = %q, want def", got["pt_login_sig"])
	}
	if _, ok := got["empty"]; ok {
		t.Fatalf("empty cookie should be skipped: %#v", got)
	}
}

func TestCookieNamesDoNotExposeValues(t *testing.T) {
	got := strings.Join(cookieNames(map[string]string{"qrsig": "SECRET", "p_skey": "KEY"}), ",")
	if got != "p_skey,qrsig" {
		t.Fatalf("cookie names = %q", got)
	}
	if strings.Contains(got, "SECRET") || strings.Contains(got, "KEY") {
		t.Fatalf("cookie names leaked values: %q", got)
	}
}

func TestFetchQQCheckSigCookiesFollowsRedirects(t *testing.T) {
	sawSessionCookie := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/start":
			sawSessionCookie = strings.Contains(r.Header.Get("Cookie"), "qrsig=abc")
			http.Redirect(w, r, "/login_jump", http.StatusFound)
		case "/login_jump":
			http.SetCookie(w, &http.Cookie{Name: "p_skey", Value: "PSKEY"})
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	got, err := fetchQQCheckSigCookiesFromURL(server.URL+"/start", map[string]string{"qrsig": "abc"})
	if err != nil {
		t.Fatalf("fetchQQCheckSigCookiesFromURL returned error: %v", err)
	}
	if !sawSessionCookie {
		t.Fatal("check_sig request did not include the QR session cookie")
	}
	if got["p_skey"] != "PSKEY" {
		t.Fatalf("p_skey = %q, want PSKEY (cookies %#v)", got["p_skey"], got)
	}
}

func TestFetchQQCheckSigCookiesUsesOriginalRedirectURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("ptsigx") != "SIGX+TOKEN" {
			t.Fatalf("ptsigx = %q, want SIGX+TOKEN", r.URL.Query().Get("ptsigx"))
		}
		http.SetCookie(w, &http.Cookie{Name: "p_skey", Value: "PSKEY"})
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	redirectURL := server.URL + "/check_sig?ptsigx=SIGX%2BTOKEN&extra=1"
	got, err := fetchQQCheckSigCookies("", "", redirectURL, map[string]string{"qrsig": "abc"})
	if err != nil {
		t.Fatalf("fetchQQCheckSigCookies returned error: %v", err)
	}
	if got["p_skey"] != "PSKEY" {
		t.Fatalf("p_skey = %q, want PSKEY", got["p_skey"])
	}
}

func TestFetchQQCheckSigCookiesAcceptsQQConnectFallbackCookies(t *testing.T) {
	visitedJump := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/start":
			http.SetCookie(w, &http.Cookie{Name: "pt_oauth_token", Value: "OAUTH"})
			http.SetCookie(w, &http.Cookie{Name: "superkey", Value: "SUPERKEY"})
			http.Redirect(w, r, "/login_jump", http.StatusFound)
		case "/login_jump":
			visitedJump = true
			http.SetCookie(w, &http.Cookie{Name: "supertoken", Value: "SUPERTOKEN"})
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	got, err := fetchQQCheckSigCookiesFromURL(server.URL+"/start", map[string]string{"qrsig": "abc"})
	if err != nil {
		t.Fatalf("fetchQQCheckSigCookiesFromURL returned error: %v", err)
	}
	if !visitedJump {
		t.Fatal("fallback auth cookies should not stop the login_jump redirect")
	}
	if got["p_skey"] != "" || got["skey"] != "" {
		t.Fatalf("test setup should not return p_skey/skey: %#v", got)
	}
	if got["superkey"] != "SUPERKEY" || got["pt_oauth_token"] != "OAUTH" {
		t.Fatalf("fallback cookies not preserved: %#v", got)
	}
}

func TestQQAuthorizeTokenCandidatesIncludeConnectFallbacks(t *testing.T) {
	got := qqAuthorizeTokenCandidates(map[string]string{
		"pt_oauth_token": "OAUTH",
		"superkey":       "SUPERKEY",
		"supertoken":     "SUPERTOKEN",
	})
	names := make([]string, 0, len(got))
	for _, candidate := range got {
		if candidate.token != "" || candidate.name == "default_5381" {
			names = append(names, candidate.name)
		}
	}
	joined := strings.Join(names, ",")
	want := "superkey,supertoken,pt_oauth_token,default_5381"
	if joined != want {
		t.Fatalf("candidate names = %q, want %q", joined, want)
	}
}

func TestSafeLocationDropsQuery(t *testing.T) {
	got := safeLocation("https://graph.qq.com/oauth2.0/login_jump?code=SECRET")
	if got != "https://graph.qq.com/oauth2.0/login_jump" {
		t.Fatalf("safeLocation = %q", got)
	}
}

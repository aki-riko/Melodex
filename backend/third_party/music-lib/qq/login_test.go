package qq

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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

func TestSafeLocationDropsQuery(t *testing.T) {
	got := safeLocation("https://graph.qq.com/oauth2.0/login_jump?code=SECRET")
	if got != "https://graph.qq.com/oauth2.0/login_jump" {
		t.Fatalf("safeLocation = %q", got)
	}
}

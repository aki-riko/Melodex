package qq

import "testing"

func TestParseQQQRCheckExtractsStrongLoginInputs(t *testing.T) {
	raw := `ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?pttype=1&uin=12345678&service=ptqrlogin&nodirect=0&ptsigx=SIGX_TOKEN&s_url=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump&ptlang=2052&ptredirect=100&aid=716027609&daid=383&j_later=0&low_login_hour=0&regmaster=0&pt_login_type=3&pt_aid=0&pt_aaid=16&pt_light=0&pt_3rd_aid=100497308','0','登录成功！','nickname');`
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
	if sigx != "SIGX_TOKEN" {
		t.Fatalf("sigx = %q, want SIGX_TOKEN", sigx)
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

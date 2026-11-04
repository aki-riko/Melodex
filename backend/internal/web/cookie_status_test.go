package web

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/aki-riko/Melodex/backend/core"
)

func TestCookieStatusDetailsAreRedactedAndAliasQQWX(t *testing.T) {
	setupUserTestDB(t)
	r := newAuthAPITestRouter(t)
	admin, _ := createUser("root", "rootpass1", RoleAdmin)
	adminCookie := mustSession(t, admin)

	core.CM.SetAll(map[string]string{
		"qq": "qqmusic_uin=123456; qm_keyst=SECRET_KEY; foo=bar",
	})

	rec := doJSON(r, http.MethodGet, "/api/v1/cookies", nil, adminCookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("cookie status code = %d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "SECRET_KEY") || strings.Contains(rec.Body.String(), "123456") {
		t.Fatalf("cookie status leaked cookie value: %s", rec.Body.String())
	}

	var body struct {
		LoggedIn map[string]bool                    `json:"logged_in"`
		Details  map[string]core.CookieStatusDetail `json:"details"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode cookie status: %v", err)
	}
	if !body.LoggedIn["qq"] {
		t.Fatalf("qq should be logged in via saved cookie: %#v", body.LoggedIn)
	}
	if !body.Details["qq"].Hints["has_music_key"] {
		t.Fatalf("qq strong credential hint missing: %#v", body.Details["qq"])
	}
	// qq_wx 自 2026-11 起不再单独出登录卡(cookieSourceNames 已移除):
	// 它只是 qq 的别名,读同一份 cookie,单独成卡会让用户以为有两个 QQ 账号。
	// 但**别名读取能力必须保留** —— 老部署若真存过 qq_wx 这个 key,仍要能认出来。
	if body.LoggedIn["qq_wx"] {
		t.Fatalf("qq_wx 不应再作为独立登录卡片返回: %#v", body.LoggedIn)
	}
	aliasDetail := core.BuildCookieStatusDetail("qq_wx", "qqmusic_uin=123456; qm_keyst=SECRET_KEY", false)
	if !aliasDetail.Saved || aliasDetail.Source != "qq" {
		t.Fatalf("qq_wx 必须仍被折叠成 qq(别名读取能力不能丢): %#v", aliasDetail)
	}
}

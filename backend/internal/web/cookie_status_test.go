package web

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/guohuiyuan/go-music-dl/core"
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
	if !body.LoggedIn["qq"] || !body.LoggedIn["qq_wx"] {
		t.Fatalf("qq and qq_wx should both be logged in via qq cookie: %#v", body.LoggedIn)
	}
	if !body.Details["qq"].Hints["has_music_key"] || !body.Details["qq_wx"].Hints["has_music_key"] {
		t.Fatalf("qq strong credential hint missing: %#v %#v", body.Details["qq"], body.Details["qq_wx"])
	}
}

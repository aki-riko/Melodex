package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/guohuiyuan/go-music-dl/core"
	"github.com/guohuiyuan/music-lib/model"
)

// TestUserPlaylistsRouteReturnsTabs 验证 /api/v1/user_playlists 按源返回 tabs,
// 且拉取失败(如未登录)的源落到 tab.Error,不影响其他源。
func TestUserPlaylistsRouteReturnsTabs(t *testing.T) {
	setupUserTestDB(t)

	origFunc := userPlaylistsFuncProvider
	origNames := userPlaylistSourceNamesGetter
	t.Cleanup(func() {
		userPlaylistsFuncProvider = origFunc
		userPlaylistSourceNamesGetter = origNames
	})

	userPlaylistSourceNamesGetter = func() []string { return []string{"netease", "qq"} }
	userPlaylistsFuncProvider = func(source string) core.UserPlaylistsFunc {
		switch source {
		case "netease":
			return func(page, limit int) ([]model.Playlist, error) {
				return []model.Playlist{
					{ID: "pl-1", Name: "我喜欢的音乐", TrackCount: 42, Creator: "me"},
				}, nil
			}
		case "qq":
			// 模拟未登录:GetUserPlaylists 返回错误。
			return func(page, limit int) ([]model.Playlist, error) {
				return nil, fmt.Errorf("qq user playlists require cookie")
			}
		default:
			return nil
		}
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterJSONAPIRoutes(r, StartOptions{DisableAuth: true})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/user_playlists", nil)
	req.Header.Set("Accept", "application/json")
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200, body=%s", rec.Code, rec.Body.String())
	}

	var resp jsonPlaylistTabsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v, body=%s", err, rec.Body.String())
	}
	if len(resp.Tabs) != 2 {
		t.Fatalf("tabs len=%d, want 2", len(resp.Tabs))
	}

	byServer := map[string]jsonPlaylistTab{}
	for _, tab := range resp.Tabs {
		byServer[tab.Source] = tab
	}

	netease, ok := byServer["netease"]
	if !ok {
		t.Fatalf("missing netease tab")
	}
	if netease.Error != "" {
		t.Fatalf("netease tab error=%q, want empty", netease.Error)
	}
	if len(netease.Playlists) != 1 || netease.Playlists[0].ID != "pl-1" {
		t.Fatalf("netease playlists=%+v, want 1 with id pl-1", netease.Playlists)
	}
	if netease.Playlists[0].Source != "netease" {
		t.Fatalf("netease playlist source=%q, want netease", netease.Playlists[0].Source)
	}

	qq, ok := byServer["qq"]
	if !ok {
		t.Fatalf("missing qq tab")
	}
	if qq.Error == "" {
		t.Fatalf("qq tab error empty, want cookie error")
	}
	if len(qq.Playlists) != 0 {
		t.Fatalf("qq playlists len=%d, want 0", len(qq.Playlists))
	}
}

// TestUserPlaylistsRouteRequiresLogin 验证非桌面模式下匿名访问被 401 拦截。
func TestUserPlaylistsRouteRequiresLogin(t *testing.T) {
	setupUserTestDB(t)
	if _, err := createUser("root", "rootpass1", RoleAdmin); err != nil {
		t.Fatalf("create root: %v", err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterJSONAPIRoutes(r, StartOptions{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/user_playlists", nil)
	req.Header.Set("Accept", "application/json")
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous status=%d, want 401, body=%s", rec.Code, rec.Body.String())
	}
}

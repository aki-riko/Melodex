package web

// NoRoute 兜底的白名单完整性(2026-11 全库扫描)。
//
// 背景:前端 SPA 的 NoRoute 兜底会把"不认识"的路径回退成 index.html。
// 这对前端路由是必需的(哈希路由外还有 /music/login 这类直达路径),
// 但对**后端接口**是灾难:客户端期望 XML/JSON,却收到一页 HTML,
// 解析失败且错误信息毫无指向性。
//
// 已挡的:/api/、/music/、/desktop/(发布产物)。
// 漏掉的:/rest/ —— Subsonic facade 注册了 ping/search3/stream/getCoverArt 等
// 一部分端点,而 Subsonic 协议里还有大量**未实现**的端点(search2、getPlaylists、
// getPodcasts、star、scrobble…)。音流/substreamer 这类客户端会试探性调用它们,
// 未实现的就会落进 NoRoute 拿到 HTML 页面。
//
// 这条测试直接打真实路由验证,而不是静态读源码 —— 因为"白名单里写没写"
// 与"实际返回什么"之间隔着一整个中间件链。

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// newNoRouteTestRouter 起一个只注册 NoRoute 兜底的最小路由。
// 不注册真实业务路由:我们要测的正是"未命中时的兜底行为"。
func newNoRouteTestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	registerFrontend(r)
	return r
}

// TestNoRouteReturns404ForBackendPrefixes 后端/接口前缀未命中时必须 404,
// 绝不能回退成 HTML —— 否则客户端会收到一页它无法解析的东西。
func TestNoRouteReturns404ForBackendPrefixes(t *testing.T) {
	r := newNoRouteTestRouter(t)

	cases := []struct {
		path string
		why  string
	}{
		{"/api/v1/does_not_exist", "未知 API 端点必须 404(前端 fetch 会解析 JSON)"},
		{"/music/does_not_exist", "旧 /music 前缀未命中必须 404"},
		{"/rest/does_not_exist", "Subsonic 未实现端点必须 404 —— 客户端要 XML/JSON,不能收到 HTML"},
		{"/rest/getPodcasts", "Subsonic 协议里我们未实现的端点(音流会试)"},
		{"/rest/search2", "Subsonic 旧版搜索端点(部分客户端仍在用)"},
		{"/desktop/does_not_exist.json", "更新器清单路径不能回退成 HTML"},
	}

	for _, tc := range cases {
		t.Run(strings.TrimPrefix(tc.path, "/"), func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			r.ServeHTTP(rec, req)

			if rec.Code != http.StatusNotFound {
				t.Fatalf("%s 返回 %d,应为 404。%s", tc.path, rec.Code, tc.why)
			}
			body := rec.Body.String()
			if strings.Contains(strings.ToLower(body), "<!doctype html") ||
				strings.Contains(strings.ToLower(body), "<html") {
				t.Fatalf("%s 回退成了 HTML 页面(前 120 字节: %.120q)。%s", tc.path, body, tc.why)
			}
		})
	}
}

// TestNoRouteFallsBackToSPAForFrontendPaths 前端路径仍必须回退到 SPA 入口 ——
// 这是修 /rest/ 时**绝不能破坏**的另一半。
func TestNoRouteFallsBackToSPAForFrontendPaths(t *testing.T) {
	r := newNoRouteTestRouter(t)

	// 这些是前端自己的路径(哈希路由之前的直达路径、登录页等)。
	// 它们必须拿到 200 + HTML,否则刷新就白屏。
	for _, path := range []string{"/", "/download", "/myplaylist/123"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		r.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("%s 返回 %d,前端路径应回退到 SPA 入口(200)", path, rec.Code)
		}
		if !strings.Contains(strings.ToLower(rec.Body.String()), "<html") {
			t.Fatalf("%s 未返回 HTML 页面(SPA 入口),body 前 120 字节: %.120q", path, rec.Body.String())
		}
	}
}

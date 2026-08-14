package web

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCoverProxyReturnsInlineImage(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// SSRF 防护:cover_proxy 拒绝代理环回/内网地址。httptest 上游监听 127.0.0.1,
	// 因此预期被拦为 403——这正是防护生效的体现,防止该公开接口被当作内网探测代理。
	imageBytes := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01, 0x02, 0x03, 0x04}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(imageBytes)
	}))
	defer upstream.Close()

	router := gin.New()
	RegisterMusicRoutes(router.Group(RoutePrefix))

	req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/cover_proxy?url="+url.QueryEscape(upstream.URL), nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("环回上游应被 SSRF 防护拦截: status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

// TestCoverProxySSRFGuard 验证 SSRF 校验对各类目标的判定。
func TestCoverProxySSRFGuard(t *testing.T) {
	blocked := []string{
		"http://127.0.0.1/x",
		"http://169.254.169.254/latest/meta-data/",
		"http://192.168.1.1/",
		"http://10.0.0.1/",
		"file:///etc/passwd",
		"ftp://example.com/x",
		"http://[::1]/x",
	}
	for _, u := range blocked {
		if err := isPublicHTTPURL(u); err == nil {
			t.Errorf("应拒绝但放行了: %s", u)
		}
	}
	allowed := []string{
		"https://p1.music.126.net/cover.jpg",
		"http://y.gtimg.cn/music/photo.jpg",
	}
	for _, u := range allowed {
		if err := isPublicHTTPURL(u); err != nil {
			t.Errorf("应放行但拒绝了: %s (%v)", u, err)
		}
	}
}

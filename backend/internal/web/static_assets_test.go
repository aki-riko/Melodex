package web

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// newStaticTestRouter 构造一个只挂前端静态路由的最小引擎。
func newStaticTestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	registerFrontend(r)
	return r
}

// TestStaticAssetsGzip 验证 JS/CSS 会返回 gzip 且内容可解压还原。
//
// 背景（2026-11 全量 Review 实测）：线上 `/assets/index-*.js` **228KB 裸传**、
// 无 Content-Encoding —— 前面的 openresty 只对 HTML 做了 gzip。
// 这个测试锁住「后端自己压」，不依赖反代配置。
func TestStaticAssetsGzip(t *testing.T) {
	r := newStaticTestRouter(t)

	// 找一个已嵌入的 .js/.css 资源路径
	sub, err := fsSubForTest()
	if err != nil {
		t.Skipf("没有嵌入前端产物: %v", err)
	}
	assetPath := findAssetForTest(sub, ".js")
	if assetPath == "" {
		t.Skip("嵌入产物里没有 .js 资源")
	}

	req := httptest.NewRequest(http.MethodGet, "/"+assetPath, nil)
	req.Header.Set("Accept-Encoding", "gzip")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("期望 200，实际 %d", w.Code)
	}
	if got := w.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding 应为 gzip，实际 %q（这是「228KB 裸传」那个 bug 的回归点）", got)
	}
	if got := w.Header().Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
		t.Fatalf("Vary 必须含 Accept-Encoding，实际 %q", got)
	}
	// 解压后必须能还原（不能压坏）
	zr, err := gzip.NewReader(w.Body)
	if err != nil {
		t.Fatalf("响应不是合法 gzip: %v", err)
	}
	plain, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("解压失败: %v", err)
	}
	if len(plain) < 100 {
		t.Fatalf("解压后内容太短（%d 字节），可能压坏了", len(plain))
	}
}

// TestStaticAssetsNoGzipWithoutAcceptEncoding 验证不支持 gzip 的客户端拿到明文。
// 若这里返回 gzip，老客户端会看到乱码。
func TestStaticAssetsNoGzipWithoutAcceptEncoding(t *testing.T) {
	r := newStaticTestRouter(t)

	sub, err := fsSubForTest()
	if err != nil {
		t.Skipf("没有嵌入前端产物: %v", err)
	}
	assetPath := findAssetForTest(sub, ".js")
	if assetPath == "" {
		t.Skip("嵌入产物里没有 .js 资源")
	}

	req := httptest.NewRequest(http.MethodGet, "/"+assetPath, nil)
	// 刻意不设 Accept-Encoding
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if got := w.Header().Get("Content-Encoding"); got == "gzip" {
		t.Fatal("客户端没声明 gzip 却返回了 gzip —— 会导致内容乱码")
	}
	if w.Body.Len() < 100 {
		t.Fatalf("明文响应太短（%d 字节）", w.Body.Len())
	}
}

// TestStaticAssetsCacheHeaders 锁缓存策略：
//   - /assets/* 带内容哈希 → 可 immutable 长缓存
//   - index.html → 必须 no-cache（否则发版后拿不到新 bundle）
func TestStaticAssetsCacheHeaders(t *testing.T) {
	r := newStaticTestRouter(t)

	// ① 哈希资源 → immutable
	sub, err := fsSubForTest()
	if err == nil {
		if assetPath := findAssetForTest(sub, ".js"); assetPath != "" {
			req := httptest.NewRequest(http.MethodGet, "/"+assetPath, nil)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			cc := w.Header().Get("Cache-Control")
			if !strings.Contains(cc, "immutable") {
				t.Errorf("/assets/* 应带 immutable 长缓存，实际 Cache-Control=%q", cc)
			}
			if !strings.Contains(cc, "max-age=31536000") {
				t.Errorf("/assets/* 的 max-age 应为一年，实际 %q", cc)
			}
		}
	}

	// ② 首页 → no-cache
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	cc := w.Header().Get("Cache-Control")
	if !strings.Contains(cc, "no-cache") {
		t.Errorf("首页必须 no-cache（否则发版后用户拿旧 index.html），实际 %q", cc)
	}
}

// TestStaticAssetsSkipsImages 验证图片不被 gzip。
// 图片本身已压缩，再 gzip 浪费 CPU 且常变大。
func TestStaticAssetsSkipsImages(t *testing.T) {
	if shouldGzip(httptest.NewRequest(http.MethodGet, "/logo512.png", nil), "/logo512.png") {
		t.Error("PNG 不应被 gzip（已压缩格式，再压会变大）")
	}
	for _, p := range []string{"/assets/a.js", "/assets/b.css", "/index.html", "/assets/c.mjs"} {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		req.Header.Set("Accept-Encoding", "gzip")
		if !shouldGzip(req, p) {
			t.Errorf("%s 应该被 gzip", p)
		}
	}
}

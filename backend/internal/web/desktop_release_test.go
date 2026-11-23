package web

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// 这组测试锁住 /desktop/ 的两条硬要求：
//  ① 命中文件时原样返回（清单是 JSON、安装包是二进制）；
//  ② **未命中必须 404，绝不能回退成 index.html**。
//
// 第 ② 条是实际踩过的坑：没有这个路由时，/desktop/latest.json 会落进 SPA fallback
// 返回 HTML 首页，更新器报 “error decoding response body”，
// 而网站本身完全正常，排查成本极高。

func desktopReleaseTestRouter(t *testing.T, dir string) *gin.Engine {
	t.Helper()
	if dir != "" {
		t.Setenv(desktopReleaseDirEnv, dir)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	registerDesktopRelease(r)
	return r
}

func TestDesktopReleaseServesManifestAsJSON(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"version":"0.1.0","platforms":{"windows-x86_64":{"signature":"sig","url":"u"}}}`
	if err := os.WriteFile(filepath.Join(dir, "latest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatalf("写测试清单失败: %v", err)
	}

	r := desktopReleaseTestRouter(t, dir)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/desktop/latest.json", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("期望 200，实际 %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("清单必须按 JSON 返回，实际 Content-Type=%q", ct)
	}
	if w.Body.String() != manifest {
		t.Fatalf("清单内容被改动：%q", w.Body.String())
	}
	// 清单不能被长缓存，否则发了新版用户还在读旧清单。
	if cc := w.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("清单应 no-cache，实际 %q", cc)
	}
}

func TestDesktopReleaseServesInstallerAsBinary(t *testing.T) {
	dir := t.TempDir()
	payload := []byte("MZ fake nsis installer")
	name := "Melodex_0.1.0_x64-setup.exe"
	if err := os.WriteFile(filepath.Join(dir, name), payload, 0o644); err != nil {
		t.Fatalf("写测试安装包失败: %v", err)
	}

	r := desktopReleaseTestRouter(t, dir)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/desktop/"+name, nil))

	if w.Code != http.StatusOK {
		t.Fatalf("期望 200，实际 %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Fatalf("安装包应按二进制下载，实际 Content-Type=%q", ct)
	}
	if w.Body.String() != string(payload) {
		t.Fatalf("安装包内容不一致")
	}
}

func TestDesktopReleaseMissingFileIs404NotHTML(t *testing.T) {
	dir := t.TempDir()
	r := desktopReleaseTestRouter(t, dir)

	for _, target := range []string{
		"/desktop/latest.json",
		"/desktop/does-not-exist.exe",
	} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, target, nil))
		if w.Code != http.StatusNotFound {
			t.Fatalf("%s 未命中时应 404，实际 %d", target, w.Code)
		}
		// 核心断言：绝不能是 HTML。
		if ct := w.Header().Get("Content-Type"); ct == "text/html; charset=utf-8" {
			t.Fatalf("%s 不得回退成 HTML 首页（会让更新器解析失败）", target)
		}
	}
}

func TestDesktopReleaseRejectsPathTraversal(t *testing.T) {
	dir := t.TempDir()
	// 在发布目录的**父目录**放一个敏感文件，确认穿越拿不到它。
	if err := os.WriteFile(filepath.Join(filepath.Dir(dir), "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatalf("写测试文件失败: %v", err)
	}

	r := desktopReleaseTestRouter(t, dir)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/desktop/../secret.txt", nil))

	if w.Code == http.StatusOK {
		t.Fatalf("路径穿越必须被拒绝，实际返回 200")
	}
}

func TestDesktopReleaseFallsBackToEmbeddedDirWhenEnvMissing(t *testing.T) {
	// 环境变量指向不存在的目录时应退回嵌入目录，而不是让路由消失。
	gin.SetMode(gin.TestMode)
	t.Setenv(desktopReleaseDirEnv, filepath.Join(t.TempDir(), "nope"))
	r := gin.New()
	registerDesktopRelease(r)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/desktop/latest.json", nil))
	// 嵌入目录只有占位，所以这里应当是 404 而不是 200 或 5xx。
	if w.Code != http.StatusNotFound {
		t.Fatalf("期望 404（占位目录为空），实际 %d", w.Code)
	}
}

func TestSPAFallbackDoesNotSwallowDesktopPrefix(t *testing.T) {
	// 关键回归：NoRoute 里必须先拦 /desktop/，否则会回退 index.html。
	//
	// ★ 为什么不直接断言 status/body：
	//   仓库里的 frontend_dist/index.html 是**占位空文件**，本地跑时 serveIndex
	//   返回空 body，所以「有没有发生 SPA 回退」在本地根本看不出来 ——
	//   本鱼前两版就这么写，结果把守卫整个删掉测试照样绿，是条假断言。
	//
	// 断言改为**直接验证守卫的判定谓词**：/desktop/ 开头的路径必须被
	// `strings.HasPrefix(p, desktopReleasePrefix)` 命中。
	// 这既是 NoRoute 里唯一的判断依据，又不依赖占位 index.html 的内容。
	//
	// 同时做一次集成对照：普通前端路由必须仍能回退（不能把 SPA 弄坏）。
	gin.SetMode(gin.TestMode)
	t.Setenv(desktopReleaseDirEnv, t.TempDir())

	// ① 谓词层：/desktop/ 前缀必须命中守卫。
	for _, p := range []string{"/desktop/latest.json", "/desktop/x.exe", "/desktop/"} {
		if !strings.HasPrefix(p, desktopReleasePrefix) {
			t.Fatalf("%q 应被 desktopReleasePrefix 命中（否则会退化成 HTML）", p)
		}
	}
	// 反向：不能被误伤
	for _, p := range []string{"/myplaylist", "/", "/api/v1/healthz"} {
		if strings.HasPrefix(p, desktopReleasePrefix) {
			t.Fatalf("%q 不应命中 desktop 前缀（会误伤正常路由）", p)
		}
	}

	// ② 源码层：NoRoute 里必须真的存在这条守卫。
	// 这是唯一能在占位 index.html 的空 body 下守住「守卫没被删」的手段。
	src, err := os.ReadFile("frontend_embed.go")
	if err != nil {
		t.Fatalf("读取 frontend_embed.go 失败: %v", err)
	}
	if !strings.Contains(string(src), "strings.HasPrefix(p, desktopReleasePrefix)") {
		t.Fatalf("NoRoute 里缺少 /desktop/ 守卫：未命中请求会回退成 HTML，更新器解析失败")
	}

	// ③ 集成层：普通前端路由仍回退 SPA（不能因为加守卫把路由弄坏）。
	r := gin.New()
	registerFrontend(r)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/myplaylist", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("普通前端路由应回退 SPA 入口（200），实际 %d", w.Code)
	}
}

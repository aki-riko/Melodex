package web

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
)

// makeToken 生成 md5(password+salt) 的小写十六进制,模拟客户端认证。
func makeToken(password, salt string) string {
	sum := md5.Sum([]byte(password + salt))
	return hex.EncodeToString(sum[:])
}

func TestLoadSubsonicConfigFromEnv(t *testing.T) {
	t.Setenv("MUSIC_DL_SUBSONIC_ENABLED", "1")
	t.Setenv("MUSIC_DL_SUBSONIC_USER", "kotori")
	t.Setenv("MUSIC_DL_SUBSONIC_PASS", "s3cret")
	cfg := loadSubsonicConfigFromEnv()
	if !cfg.Enabled || cfg.User != "kotori" || cfg.Password != "s3cret" {
		t.Fatalf("配置解析错误: %+v", cfg)
	}

	// 缺凭据时强制关闭,即使 ENABLED=1。
	t.Setenv("MUSIC_DL_SUBSONIC_PASS", "")
	cfg = loadSubsonicConfigFromEnv()
	if cfg.Enabled {
		t.Fatalf("缺密码时应强制关闭,实际 enabled=%v", cfg.Enabled)
	}

	// ENABLED 未设时默认关。
	t.Setenv("MUSIC_DL_SUBSONIC_ENABLED", "")
	t.Setenv("MUSIC_DL_SUBSONIC_PASS", "s3cret")
	cfg = loadSubsonicConfigFromEnv()
	if cfg.Enabled {
		t.Fatalf("ENABLED 未设时应默认关")
	}
}

func TestVerifySubsonicToken(t *testing.T) {
	cfg := subsonicConfig{Enabled: true, User: "kotori", Password: "sesame"}

	// 协议文档示例:password=sesame salt=c19b2d → 26719a1196d2a940705a59634eb18eab
	if got := makeToken("sesame", "c19b2d"); got != "26719a1196d2a940705a59634eb18eab" {
		t.Fatalf("token 计算与协议文档不符: %s", got)
	}

	salt := "c19b2d"
	token := makeToken("sesame", salt)
	if !verifySubsonicToken(cfg, "kotori", token, salt, "") {
		t.Fatal("正确 token 应通过")
	}
	// 用户名大小写不敏感
	if !verifySubsonicToken(cfg, "KOTORI", token, salt, "") {
		t.Fatal("用户名应大小写不敏感")
	}
	// 错误 token
	if verifySubsonicToken(cfg, "kotori", "deadbeef", salt, "") {
		t.Fatal("错误 token 不应通过")
	}
	// 错误用户名
	if verifySubsonicToken(cfg, "other", token, salt, "") {
		t.Fatal("错误用户名不应通过")
	}
	// 明文密码
	if !verifySubsonicToken(cfg, "kotori", "", "", "sesame") {
		t.Fatal("正确明文密码应通过")
	}
	if verifySubsonicToken(cfg, "kotori", "", "", "wrong") {
		t.Fatal("错误明文密码不应通过")
	}
	// 空凭据配置一律拒绝
	empty := subsonicConfig{Enabled: true}
	if verifySubsonicToken(empty, "kotori", token, salt, "") {
		t.Fatal("空配置不应通过认证")
	}
}

// newSubsonicTestRouter 构造启用 facade 的测试路由(注入测试配置)。
func newSubsonicTestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	t.Setenv("MUSIC_DL_SUBSONIC_ENABLED", "1")
	t.Setenv("MUSIC_DL_SUBSONIC_USER", "kotori")
	t.Setenv("MUSIC_DL_SUBSONIC_PASS", "sesame")
	// 重置 once 并预填缓存,使 getSubsonicConfig 返回测试配置(每个测试独立)。
	subsonicConfigOnce = sync.Once{}
	subsonicConfigCache = loadSubsonicConfigFromEnv()
	subsonicConfigOnce.Do(func() {})
	r := gin.New()
	RegisterSubsonicRoutes(r)
	return r
}

func TestSubsonicPingJSON(t *testing.T) {
	r := newSubsonicTestRouter(t)
	salt := "abcdef"
	token := makeToken("sesame", salt)
	url := "/rest/ping?u=kotori&t=" + token + "&s=" + salt + "&v=1.16.1&c=test&f=json"
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("ping 应返回 200, 实际 %d", rec.Code)
	}
	var parsed struct {
		Response struct {
			Status  string `json:"status"`
			Version string `json:"version"`
		} `json:"subsonic-response"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("JSON 解析失败: %v, body=%s", err, rec.Body.String())
	}
	if parsed.Response.Status != "ok" || parsed.Response.Version != "1.16.1" {
		t.Fatalf("ping 响应异常: %+v", parsed.Response)
	}
}

func TestSubsonicPingBadAuth(t *testing.T) {
	r := newSubsonicTestRouter(t)
	url := "/rest/ping?u=kotori&t=wrongtoken&s=abcdef&v=1.16.1&c=test&f=json"
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, "\"status\":\"failed\"") || !strings.Contains(body, "\"code\":40") {
		t.Fatalf("错误认证应返回 failed + code 40, 实际 body=%s", body)
	}
}

func TestSubsonicGetLicenseXML(t *testing.T) {
	r := newSubsonicTestRouter(t)
	salt := "abcdef"
	token := makeToken("sesame", salt)
	url := "/rest/getLicense?u=kotori&t=" + token + "&s=" + salt + "&v=1.16.1&c=test"
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, "subsonic-response") || !strings.Contains(body, "status=\"ok\"") {
		t.Fatalf("getLicense XML 响应异常: %s", body)
	}
	if !strings.Contains(body, "valid=\"true\"") {
		t.Fatalf("license 应 valid=true: %s", body)
	}
}

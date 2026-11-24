package web

// 内部错误不得出现在客户端响应体里(2026-11 全库扫描)。
//
// 背景:全库曾有 20+ 处 `c.JSON(500, gin.H{"error": err.Error()})`。真实的内部
// 错误会带出 SQLite/Postgres 的表名与约束名、容器内绝对路径、上游服务地址与
// 端口、甚至 net/http 的底层栈。普通用户看到没用,攻击者能拿来摸清部署结构。
//
// 但要区分两类,**不能一刀切遮蔽**:
//   · 用户输入错误(参数不合法、M3U 格式错、endpoint 配错)→ 必须告诉用户原因;
//   · 内部错误(数据库失败、磁盘满、上游 502)→ 只回固定文案 + request id。
//
// 这条测试从**真实 HTTP 响应**上验证,而不是静态读源码 ——
// "代码里调了 respondInternalError"与"实际响应没泄漏"之间隔着整个中间件链。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestRespondInternalErrorHidesDetail 直接验证工具函数本身的行为。
func TestRespondInternalErrorHidesDetail(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	const secretInError = "no such table: user_secrets_v2"

	r.GET("/boom", func(c *gin.Context) {
		respondInternalError(c, "保存失败", errStub(secretInError))
	})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/boom", nil))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("状态码 = %d, want 500", rec.Code)
	}

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是 JSON: %v (body=%q)", err, rec.Body.String())
	}

	msg, _ := body["error"].(string)
	if msg != "保存失败" {
		t.Fatalf("error 字段 = %q, want 固定文案「保存失败」", msg)
	}

	// ★ 核心断言:原始错误串绝不能出现在响应体里。
	if strings.Contains(rec.Body.String(), "user_secrets_v2") {
		t.Fatalf("内部错误详情泄漏到响应体: %q", rec.Body.String())
	}

	// request id 必须回给客户端,便于用户报障时精确定位日志。
	id := rec.Header().Get(clientErrorIDHeader)
	if id == "" {
		t.Fatalf("响应头缺少 %s —— 用户报障时无法定位日志", clientErrorIDHeader)
	}
	if got, _ := body["request_id"].(string); got != id {
		t.Fatalf("响应体 request_id(%q)与响应头(%q)不一致", got, id)
	}
}

// TestRespondInternalErrorReusesUpstreamRequestID 反代已生成 request id 时必须复用,
// 否则用户报的 id 与网关日志对不上。
func TestRespondInternalErrorReusesUpstreamRequestID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/boom", func(c *gin.Context) {
		respondInternalError(c, "失败", errStub("disk full"))
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/boom", nil)
	req.Header.Set("X-Request-Id", "gateway-abc-123")
	r.ServeHTTP(rec, req)

	if got := rec.Header().Get(clientErrorIDHeader); got != "gateway-abc-123" {
		t.Fatalf("应复用上游 request id, got %q", got)
	}
}

// TestRespondBadRequestKeepsUserFacingMessage 用户输入错误必须保留原因,
// 不能被顺手遮蔽 —— 否则用户不知道该怎么改。
func TestRespondBadRequestKeepsUserFacingMessage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/bad", func(c *gin.Context) {
		respondBadRequest(c, "M3U 文件格式不正确, 第 3 行缺少时长")
	})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/bad", nil))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("状态码 = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "第 3 行缺少时长") {
		t.Fatalf("400 响应必须保留可操作的错误原因, got %q", rec.Body.String())
	}
}

// errStub 是一个可控文案的 error。
func errStub(msg string) error { return stubError(msg) }

type stubError string

func (e stubError) Error() string { return string(e) }

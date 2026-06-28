package web

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// newAuthAPITestRouter 构建一个挂了完整 /api/v1 鉴权与用户管理路由的测试 router(非桌面模式)。
func newAuthAPITestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	resetAuthRuntimeForTest()
	t.Cleanup(resetAuthRuntimeForTest)
	r := gin.New()
	api := r.Group("/api/v1")
	registerAuthAPIRoutes(api, StartOptions{})
	adminSecure := api.Group("")
	adminSecure.Use(authRequired(), adminRequired())
	registerLoginAndCookieRoutes(adminSecure)
	registerAdminUserRoutes(adminSecure)
	return r
}

func jsonBody(v interface{}) *bytes.Buffer {
	b, _ := json.Marshal(v)
	return bytes.NewBuffer(b)
}

// doJSON 发一个带 JSON body 的请求,可选携带 cookie。
func doJSON(r *gin.Engine, method, path string, body interface{}, cookie *http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, jsonBody(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func sessionCookieFromRec(rec *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range rec.Result().Cookies() {
		if c.Name == authCookieName && c.Value != "" {
			return c
		}
	}
	return nil
}

func TestSetupCreatesFirstAdminThenBlocked(t *testing.T) {
	setupUserTestDB(t)
	r := newAuthAPITestRouter(t)

	// 准备一次性初始化令牌(模拟服务启动时生成)。
	token, err := prepareSetupToken(false)
	if err != nil {
		t.Fatalf("prepareSetupToken: %v", err)
	}

	// 缺令牌 → 403。
	rec := doJSON(r, http.MethodPost, "/api/v1/auth/setup", map[string]string{
		"username": "root", "password": "rootpass1",
	}, nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("setup without token should be 403, got %d", rec.Code)
	}

	// 带正确令牌 → 成功。
	rec = doJSON(r, http.MethodPost, "/api/v1/auth/setup", map[string]string{
		"username": "root", "password": "rootpass1", "setup_token": token,
	}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("setup status = %d body=%s", rec.Code, rec.Body.String())
	}
	if sessionCookieFromRec(rec) == nil {
		t.Fatal("setup should set a session cookie")
	}

	// 第二次 setup 应被拒绝(已有用户)。
	rec = doJSON(r, http.MethodPost, "/api/v1/auth/setup", map[string]string{
		"username": "root2", "password": "rootpass2", "setup_token": token,
	}, nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("second setup status = %d, want 409", rec.Code)
	}
}

func TestLoginAndMe(t *testing.T) {
	setupUserTestDB(t)
	r := newAuthAPITestRouter(t)
	if _, err := createUser("alice", "alicepass1", RoleUser); err != nil {
		t.Fatalf("seed user: %v", err)
	}

	// 错误密码。
	rec := doJSON(r, http.MethodPost, "/api/v1/auth/login", map[string]string{
		"username": "alice", "password": "wrong",
	}, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("bad login status = %d, want 401", rec.Code)
	}

	// 正确密码(清除前一次失败导致的限流锁,模拟用户稍后重试)。
	resetAuthRuntimeForTest()
	rec = doJSON(r, http.MethodPost, "/api/v1/auth/login", map[string]string{
		"username": "alice", "password": "alicepass1",
	}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("login status = %d body=%s", rec.Code, rec.Body.String())
	}
	cookie := sessionCookieFromRec(rec)
	if cookie == nil {
		t.Fatal("login should set session cookie")
	}

	// /me 带 cookie 返回当前用户。
	meReq := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	meReq.Header.Set("Accept", "application/json")
	meReq.AddCookie(cookie)
	meRec := httptest.NewRecorder()
	r.ServeHTTP(meRec, meReq)
	if meRec.Code != http.StatusOK {
		t.Fatalf("/me status = %d", meRec.Code)
	}
	var meResp struct {
		User publicUser `json:"user"`
	}
	if err := json.Unmarshal(meRec.Body.Bytes(), &meResp); err != nil {
		t.Fatalf("decode /me: %v", err)
	}
	if meResp.User.Username != "alice" || meResp.User.Role != RoleUser {
		t.Fatalf("unexpected /me user: %+v", meResp.User)
	}
}

func TestRegisterRespectsToggle(t *testing.T) {
	setupUserTestDB(t)
	r := newAuthAPITestRouter(t)
	// 需要至少一个用户存在(否则 /me 等无关;register 本身不依赖,但语义上系统已初始化)。
	if _, err := createUser("root", "rootpass1", RoleAdmin); err != nil {
		t.Fatalf("seed root: %v", err)
	}

	// 默认关闭 → 403。
	rec := doJSON(r, http.MethodPost, "/api/v1/auth/register", map[string]string{
		"username": "newbie", "password": "newpass11",
	}, nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("register while closed status = %d, want 403", rec.Code)
	}

	// 打开后 → 成功创建普通用户。
	if err := setRegistrationAllowed(true); err != nil {
		t.Fatalf("setRegistrationAllowed: %v", err)
	}
	rec = doJSON(r, http.MethodPost, "/api/v1/auth/register", map[string]string{
		"username": "newbie", "password": "newpass11",
	}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("register while open status = %d body=%s", rec.Code, rec.Body.String())
	}
	u, err := findUserByUsername("newbie")
	if err != nil {
		t.Fatalf("registered user missing: %v", err)
	}
	if u.Role != RoleUser {
		t.Fatalf("self-registered user role = %q, want user", u.Role)
	}
}

func TestAdminUserRoutesRequireAdmin(t *testing.T) {
	setupUserTestDB(t)
	r := newAuthAPITestRouter(t)
	admin, _ := createUser("root", "rootpass1", RoleAdmin)
	plain, _ := createUser("alice", "alicepass1", RoleUser)

	adminCookie := mustSession(t, admin)
	userCookie := mustSession(t, plain)

	// 普通用户访问用户管理 → 403。
	rec := doJSON(r, http.MethodGet, "/api/v1/admin/users", nil, userCookie)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("user listing users status = %d, want 403", rec.Code)
	}

	// 管理员可列出。
	rec = doJSON(r, http.MethodGet, "/api/v1/admin/users", nil, adminCookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin listing users status = %d body=%s", rec.Code, rec.Body.String())
	}

	// 普通用户改 cookie → 403(平台 cookie 管理员独占)。
	rec = doJSON(r, http.MethodPost, "/api/v1/cookies/netease", map[string]string{"cookie": "x"}, userCookie)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("user setting cookie status = %d, want 403", rec.Code)
	}

	// 管理员不能删除自己。
	rec = doJSON(r, http.MethodDelete, "/api/v1/admin/users/"+uintToStr(admin.ID), nil, adminCookie)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("admin deleting self status = %d, want 400", rec.Code)
	}

	// 管理员删除普通用户成功。
	rec = doJSON(r, http.MethodDelete, "/api/v1/admin/users/"+uintToStr(plain.ID), nil, adminCookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin deleting user status = %d body=%s", rec.Code, rec.Body.String())
	}
	if _, err := findUserByID(plain.ID); err != ErrUserNotFound {
		t.Fatalf("deleted user should be gone, got %v", err)
	}
}

func mustSession(t *testing.T, u *User) *http.Cookie {
	t.Helper()
	value, err := createUserSession(u, time.Now())
	if err != nil {
		t.Fatalf("createUserSession: %v", err)
	}
	return &http.Cookie{Name: authCookieName, Value: value}
}

func uintToStr(n uint) string {
	return strconv.FormatUint(uint64(n), 10)
}

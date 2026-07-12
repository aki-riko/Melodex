package web

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/guohuiyuan/go-music-dl/core"
)

func TestPrepareSetupTokenLifecycle(t *testing.T) {
	resetAuthRuntimeForTest()
	t.Cleanup(resetAuthRuntimeForTest)

	// 无用户(未配置)时生成令牌。
	token, err := prepareSetupToken(false)
	if err != nil {
		t.Fatalf("prepare setup token: %v", err)
	}
	if token == "" {
		t.Fatal("setup token should not be empty")
	}
	if got := currentSetupToken(); got != token {
		t.Fatalf("current setup token = %q, want %q", got, token)
	}

	again, err := prepareSetupToken(false)
	if err != nil {
		t.Fatalf("prepare setup token again: %v", err)
	}
	if again != token {
		t.Fatalf("setup token changed before consumption: got %q want %q", again, token)
	}

	consumeSetupToken()
	if got := currentSetupToken(); got != "" {
		t.Fatalf("setup token should be consumed, got %q", got)
	}

	// 已有用户(已配置)则不生成令牌。
	configuredToken, err := prepareSetupToken(true)
	if err != nil {
		t.Fatalf("prepare configured setup token: %v", err)
	}
	if configuredToken != "" {
		t.Fatalf("configured auth should not have setup token, got %q", configuredToken)
	}
}

func TestUserSessionValidation(t *testing.T) {
	setupUserTestDB(t)
	u, err := createUser("owner", "ownerpass1", RoleAdmin)
	if err != nil {
		t.Fatalf("createUser: %v", err)
	}
	secret, err := signingSecret()
	if err != nil {
		t.Fatalf("signingSecret: %v", err)
	}
	now := time.Unix(1_700_000_000, 0)

	value, err := createUserSession(u, now)
	if err != nil {
		t.Fatalf("create session value: %v", err)
	}
	if _, ok := parseSessionValue(secret, value, now.Add(time.Minute)); !ok {
		t.Fatal("fresh session should be valid")
	}
	if _, ok := parseSessionValue(secret, value+"x", now.Add(time.Minute)); ok {
		t.Fatal("tampered session should be invalid")
	}
	if _, ok := parseSessionValue(secret, value, now.Add(sessionMaxAge()+time.Second)); ok {
		t.Fatal("expired session should be invalid")
	}
	if _, ok := parseSessionValue("other-secret", value, now.Add(time.Minute)); ok {
		t.Fatal("session signed with another secret should be invalid")
	}
	// payload 携带正确的 UserID。
	payload, ok := parseSessionValue(secret, value, now.Add(time.Minute))
	if !ok || payload.UserID != u.ID {
		t.Fatalf("session payload UserID = %d, want %d", payload.UserID, u.ID)
	}
}

func TestSessionMaxAgeConfig(t *testing.T) {
	t.Setenv(sessionMaxAgeEnv, "")
	t.Setenv(sessionDaysEnv, "")
	if got := sessionMaxAge(); got != defaultSessionMaxAge {
		t.Fatalf("default session max age = %s, want %s", got, defaultSessionMaxAge)
	}

	t.Setenv(sessionMaxAgeEnv, "720h")
	if got := sessionMaxAge(); got != 30*24*time.Hour {
		t.Fatalf("duration env session max age = %s, want 720h", got)
	}

	t.Setenv(sessionMaxAgeEnv, "")
	t.Setenv(sessionDaysEnv, "365")
	if got := sessionMaxAge(); got != 365*24*time.Hour {
		t.Fatalf("days env session max age = %s, want 365d", got)
	}

	t.Setenv(sessionMaxAgeEnv, "bad")
	t.Setenv(sessionDaysEnv, "0")
	if got := sessionMaxAge(); got != defaultSessionMaxAge {
		t.Fatalf("invalid env should fall back to default, got %s", got)
	}
}

func TestLoginFailureLocksAndClears(t *testing.T) {
	resetAuthRuntimeForTest()
	t.Cleanup(resetAuthRuntimeForTest)

	now := time.Unix(1000, 0)
	key := "owner|127.0.0.1"
	firstLockedUntil := recordLoginFailure(key, now)
	if firstLockedUntil.Sub(now) != loginLockBaseDelay {
		t.Fatalf("first lock delay = %s, want %s", firstLockedUntil.Sub(now), loginLockBaseDelay)
	}
	if got, locked := loginLockedUntil(key, now.Add(500*time.Millisecond)); !locked || !got.Equal(firstLockedUntil) {
		t.Fatalf("login should be locked until %s, got %s locked=%v", firstLockedUntil, got, locked)
	}
	if _, locked := loginLockedUntil(key, firstLockedUntil.Add(time.Millisecond)); locked {
		t.Fatal("expired lock should not remain locked")
	}

	secondLockedUntil := recordLoginFailure(key, firstLockedUntil.Add(time.Millisecond))
	if secondLockedUntil.Sub(firstLockedUntil.Add(time.Millisecond)) != 2*loginLockBaseDelay {
		t.Fatalf("second lock delay = %s, want %s", secondLockedUntil.Sub(firstLockedUntil.Add(time.Millisecond)), 2*loginLockBaseDelay)
	}
	clearLoginFailures(key)
	if _, locked := loginLockedUntil(key, secondLockedUntil.Add(-time.Millisecond)); locked {
		t.Fatal("cleared failures should unlock login")
	}
}

func TestSafeAuthRedirectTarget(t *testing.T) {
	tests := []struct {
		raw  string
		want string
	}{
		{raw: "", want: "/"},
		{raw: "/music/search?q=test", want: "/music/search?q=test"},
		{raw: "/music/login", want: "/"},
		{raw: "/music/setup", want: "/"},
		{raw: "/music", want: "/"},
		{raw: "/other", want: "/other"},
		{raw: "https://example.com/music", want: "/"},
		{raw: "//example.com/music", want: "/"},
	}

	for _, tt := range tests {
		if got := safeAuthRedirectTarget(tt.raw); got != tt.want {
			t.Fatalf("safeAuthRedirectTarget(%q) = %q, want %q", tt.raw, got, tt.want)
		}
	}
}

func TestLoginAuthPageDoesNotRenderProvidedUsername(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.SetHTMLTemplate(newTestTemplate(t))
	router.GET(RoutePrefix+"/login", func(c *gin.Context) {
		renderAuthPage(c, "login", "", "private-owner")
	})

	req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/login", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	body := rec.Body.String()
	if strings.Contains(body, "private-owner") {
		t.Fatal("login page should not render configured username")
	}
	if strings.Contains(body, `name="username" value=`) {
		t.Fatal("login username input should not render a value attribute")
	}
	if !strings.Contains(body, `name="username"`) || !strings.Contains(body, `autocomplete="off"`) {
		t.Fatal("login username input should disable autocomplete")
	}
}

func TestSetupAuthPageKeepsProvidedUsername(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.SetHTMLTemplate(newTestTemplate(t))
	router.GET(RoutePrefix+"/setup", func(c *gin.Context) {
		renderAuthPage(c, "setup", "", "setup-owner")
	})

	req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/setup", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `name="username" value="setup-owner" autocomplete="username"`) {
		t.Fatal("setup username input should preserve the provided username")
	}
}

func TestAllowSaveLocalRequestRequiresPostAndSameOriginXHR(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tests := []struct {
		name       string
		method     string
		origin     string
		xrw        string
		withUser   bool
		expected   string
		wantStatus int
		wantAllow  bool
		wantCode   string
	}{
		{name: "get rejected", method: http.MethodGet, xrw: "XMLHttpRequest", wantStatus: http.StatusMethodNotAllowed},
		{name: "missing xhr rejected", method: http.MethodPost, wantStatus: http.StatusForbidden},
		{name: "cross origin rejected", method: http.MethodPost, xrw: "XMLHttpRequest", origin: "https://evil.example", wantStatus: http.StatusForbidden},
		{name: "same origin but unauthenticated rejected", method: http.MethodPost, xrw: "XMLHttpRequest", origin: "http://example.test", wantStatus: http.StatusUnauthorized},
		{name: "same origin authenticated allowed", method: http.MethodPost, xrw: "XMLHttpRequest", origin: "http://example.test", withUser: true, wantAllow: true},
		{name: "matching expected user allowed", method: http.MethodPost, xrw: "XMLHttpRequest", origin: "http://example.test", withUser: true, expected: "1", wantAllow: true},
		{name: "changed user rejected", method: http.MethodPost, xrw: "XMLHttpRequest", origin: "http://example.test", withUser: true, expected: "2", wantStatus: http.StatusConflict, wantCode: "user_changed"},
		{name: "invalid expected user rejected", method: http.MethodPost, xrw: "XMLHttpRequest", origin: "http://example.test", withUser: true, expected: "not-a-user", wantStatus: http.StatusBadRequest, wantCode: "invalid_expected_user"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(rec)
			req := httptest.NewRequest(tt.method, "http://example.test"+RoutePrefix+"/download?save_local=1", nil)
			if tt.origin != "" {
				req.Header.Set("Origin", tt.origin)
			}
			if tt.xrw != "" {
				req.Header.Set("X-Requested-With", tt.xrw)
			}
			if tt.expected != "" {
				req.Header.Set(expectedSaveUserHeader, tt.expected)
			}
			c.Request = req
			if tt.withUser {
				c.Set(ctxUserID, uint(1))
				c.Set(ctxUserRole, RoleUser)
			}

			gotAllow := allowSaveLocalRequest(c)
			if gotAllow != tt.wantAllow {
				t.Fatalf("allowSaveLocalRequest = %v, want %v", gotAllow, tt.wantAllow)
			}
			if !tt.wantAllow && rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
			if tt.wantCode != "" && !strings.Contains(rec.Body.String(), `"code":"`+tt.wantCode+`"`) {
				t.Fatalf("body = %s, want code %q", rec.Body.String(), tt.wantCode)
			}
		})
	}
}

func TestCORSAllowsExpectedSaveUserHeader(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(corsMiddleware())
	router.OPTIONS("/test", func(c *gin.Context) { c.Status(http.StatusOK) })

	req := httptest.NewRequest(http.MethodOptions, "http://example.test/test", nil)
	req.Header.Set("Origin", "http://example.test")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
	allowed := rec.Header().Get("Access-Control-Allow-Headers")
	if !strings.Contains(allowed, expectedSaveUserHeader) {
		t.Fatalf("Access-Control-Allow-Headers = %q, want %q", allowed, expectedSaveUserHeader)
	}
}

func TestAuthRequiredRedirectsWhenSetupMissing(t *testing.T) {
	setupUserTestDB(t) // 无用户
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(authRequired())
	router.GET(RoutePrefix, func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})

	req := httptest.NewRequest(http.MethodGet, RoutePrefix, nil)
	req.Header.Set("Accept", "text/html")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusFound)
	}
	if got := rec.Header().Get("Location"); got != RoutePrefix+"/setup" {
		t.Fatalf("Location = %q, want setup", got)
	}
}

func TestAuthRequiredAllowsSignedSession(t *testing.T) {
	setupUserTestDB(t)
	gin.SetMode(gin.TestMode)
	u, err := createUser("owner", "ownerpass1", RoleUser)
	if err != nil {
		t.Fatalf("createUser: %v", err)
	}
	value, err := createUserSession(u, time.Now())
	if err != nil {
		t.Fatalf("create session value: %v", err)
	}

	router := gin.New()
	router.Use(authRequired())
	router.GET(RoutePrefix, func(c *gin.Context) {
		c.String(http.StatusOK, c.GetString(ctxUsername))
	})

	req := httptest.NewRequest(http.MethodGet, RoutePrefix, nil)
	req.AddCookie(&http.Cookie{Name: authCookieName, Value: value})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if rec.Body.String() != "owner" {
		t.Fatalf("body = %q, want owner", rec.Body.String())
	}
}

func signedSessionForAuthTest(t *testing.T, u *User, secret string, now time.Time) string {
	t.Helper()
	raw, err := json.Marshal(sessionPayload{
		UserID:   u.ID,
		Username: u.Username,
		Epoch:    u.SessionEpoch,
		IssuedAt: now.Unix(),
		Nonce:    "test-nonce",
	})
	if err != nil {
		t.Fatalf("marshal session: %v", err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(raw)
	return encoded + "." + signSessionPayload(secret, encoded)
}

func TestAuthRequiredKeepsCookieOnAuthBackendError(t *testing.T) {
	setupUserTestDB(t)
	gin.SetMode(gin.TestMode)
	u, err := createUser("owner", "ownerpass1", RoleUser)
	if err != nil {
		t.Fatalf("createUser: %v", err)
	}
	value := signedSessionForAuthTest(t, u, "sekret", time.Now())

	core.ResetConfigStateForTest()
	resetAuthRuntimeForTest()
	t.Cleanup(func() {
		core.ResetConfigStateForTest()
		resetAuthRuntimeForTest()
	})
	t.Setenv(core.DatabaseDriverEnv, "unsupported")

	router := gin.New()
	router.Use(authRequired())
	router.GET("/secure", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})

	req := httptest.NewRequest(http.MethodGet, "/secure", nil)
	req.Header.Set("Accept", "application/json")
	req.AddCookie(&http.Cookie{Name: authCookieName, Value: value})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503, body=%s", rec.Code, rec.Body.String())
	}
	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == authCookieName {
			t.Fatalf("auth backend error must not clear session cookie: %+v", cookie)
		}
	}
}

func TestAdminRequiredBlocksNonAdmin(t *testing.T) {
	setupUserTestDB(t)
	gin.SetMode(gin.TestMode)
	user, err := createUser("plainuser", "userpass1", RoleUser)
	if err != nil {
		t.Fatalf("createUser: %v", err)
	}
	value, err := createUserSession(user, time.Now())
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	router := gin.New()
	grp := router.Group("")
	grp.Use(authRequired(), adminRequired())
	grp.GET("/admin-only", func(c *gin.Context) { c.String(http.StatusOK, "secret") })

	req := httptest.NewRequest(http.MethodGet, "/admin-only", nil)
	req.Header.Set("Accept", "application/json")
	req.AddCookie(&http.Cookie{Name: authCookieName, Value: value})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin status = %d, want 403", rec.Code)
	}
}

func TestDesktopModeSkipsWebAuthMiddleware(t *testing.T) {
	setupUserTestDB(t)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	api := router.Group(RoutePrefix)
	_, userAPI := bindAuthMiddleware(api, StartOptions{DisableAuth: true})
	userAPI.GET("", func(c *gin.Context) {
		c.String(http.StatusOK, "desktop")
	})

	req := httptest.NewRequest(http.MethodGet, RoutePrefix, nil)
	req.Header.Set("Accept", "text/html")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if rec.Body.String() != "desktop" {
		t.Fatalf("body = %q, want desktop", rec.Body.String())
	}
}

func TestConfigAuthOnlyProtectsConfigRoutes(t *testing.T) {
	setupUserTestDB(t)
	if _, err := createUser("owner", "ownerpass1", RoleAdmin); err != nil {
		t.Fatalf("createUser: %v", err)
	}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	api := router.Group(RoutePrefix)
	configAPI := api.Group("")
	configAPI.Use(authRequired(), adminRequired())
	api.GET("", func(c *gin.Context) {
		c.String(http.StatusOK, "public")
	})
	configAPI.GET("/cookies", func(c *gin.Context) {
		c.String(http.StatusOK, "config")
	})
	configAPI.HEAD("/cookies", func(c *gin.Context) {
		c.Status(http.StatusNoContent)
	})

	publicReq := httptest.NewRequest(http.MethodGet, RoutePrefix, nil)
	publicReq.Header.Set("Accept", "text/html")
	publicRec := httptest.NewRecorder()
	router.ServeHTTP(publicRec, publicReq)
	if publicRec.Code != http.StatusOK {
		t.Fatalf("public status = %d, want %d", publicRec.Code, http.StatusOK)
	}

	configReq := httptest.NewRequest(http.MethodGet, RoutePrefix+"/cookies", nil)
	configReq.Header.Set("Accept", "application/json")
	configRec := httptest.NewRecorder()
	router.ServeHTTP(configRec, configReq)
	if configRec.Code != http.StatusUnauthorized {
		t.Fatalf("config status = %d, want %d", configRec.Code, http.StatusUnauthorized)
	}

	headReq := httptest.NewRequest(http.MethodHead, RoutePrefix+"/cookies", nil)
	headReq.Header.Set("Accept", "application/json")
	headRec := httptest.NewRecorder()
	router.ServeHTTP(headRec, headReq)
	if headRec.Code != http.StatusUnauthorized {
		t.Fatalf("config HEAD status = %d, want %d", headRec.Code, http.StatusUnauthorized)
	}
}

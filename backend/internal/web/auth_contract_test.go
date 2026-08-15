package web

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/gin-gonic/gin"
)

func TestSetupTokenContract(t *testing.T) {
	resetAuthRuntimeForTest()
	t.Cleanup(resetAuthRuntimeForTest)
	token, err := prepareSetupToken(false)
	if err != nil || token == "" {
		t.Fatalf("prepare setup token = %q, %v", token, err)
	}
	if currentSetupToken() != token {
		t.Fatal("prepared token is not the active setup token")
	}
	if again, err := prepareSetupToken(false); err != nil || again != token {
		t.Fatalf("repeated setup token = %q, %v; want stable %q", again, err, token)
	}
	consumeSetupToken()
	if currentSetupToken() != "" {
		t.Fatal("consumed setup token remains active")
	}
	if configured, err := prepareSetupToken(true); err != nil || configured != "" {
		t.Fatalf("configured instance setup token = %q, %v", configured, err)
	}
}

func TestSignedSessionContractAndLifetime(t *testing.T) {
	setupUserTestDB(t)
	user, err := createUser("owner", "ownerpass1", RoleAdmin)
	if err != nil {
		t.Fatalf("create session owner: %v", err)
	}
	secret, err := signingSecret()
	if err != nil {
		t.Fatalf("load signing secret: %v", err)
	}
	issuedAt := time.Unix(1_700_000_000, 0)
	value, err := createUserSession(user, issuedAt)
	if err != nil {
		t.Fatalf("create user session: %v", err)
	}
	payload, ok := parseSessionValue(secret, value, issuedAt.Add(time.Minute))
	if !ok || payload.UserID != user.ID {
		t.Fatalf("fresh session payload = %#v, valid=%v", payload, ok)
	}
	invalidCases := []struct {
		name, secret, value string
		now                 time.Time
	}{
		{"tampered", secret, value + "x", issuedAt.Add(time.Minute)},
		{"wrong secret", "other-secret", value, issuedAt.Add(time.Minute)},
		{"expired", secret, value, issuedAt.Add(sessionMaxAge() + time.Second)},
	}
	for _, tc := range invalidCases {
		if _, ok := parseSessionValue(tc.secret, tc.value, tc.now); ok {
			t.Fatalf("%s session was accepted", tc.name)
		}
	}

	t.Setenv(sessionMaxAgeEnv, "")
	t.Setenv(sessionDaysEnv, "")
	if got := sessionMaxAge(); got != defaultSessionMaxAge {
		t.Fatalf("default session age = %s, want %s", got, defaultSessionMaxAge)
	}
	t.Setenv(sessionMaxAgeEnv, "720h")
	if got := sessionMaxAge(); got != 30*24*time.Hour {
		t.Fatalf("duration session age = %s", got)
	}
	t.Setenv(sessionMaxAgeEnv, "")
	t.Setenv(sessionDaysEnv, "365")
	if got := sessionMaxAge(); got != 365*24*time.Hour {
		t.Fatalf("day-based session age = %s", got)
	}
	t.Setenv(sessionMaxAgeEnv, "bad")
	t.Setenv(sessionDaysEnv, "0")
	if got := sessionMaxAge(); got != defaultSessionMaxAge {
		t.Fatalf("invalid session age fallback = %s", got)
	}
}

func TestLoginAttemptThrottleContract(t *testing.T) {
	resetAuthRuntimeForTest()
	t.Cleanup(resetAuthRuntimeForTest)
	started := time.Unix(1_000, 0)
	key := "owner|127.0.0.1"
	first := recordLoginFailure(key, started)
	if first.Sub(started) != loginLockBaseDelay {
		t.Fatalf("first lock delay = %s", first.Sub(started))
	}
	if until, locked := loginLockedUntil(key, started.Add(500*time.Millisecond)); !locked || !until.Equal(first) {
		t.Fatalf("active lock = %s/%v, want %s/true", until, locked, first)
	}
	if _, locked := loginLockedUntil(key, first.Add(time.Millisecond)); locked {
		t.Fatal("expired login lock remains active")
	}
	secondStart := first.Add(time.Millisecond)
	second := recordLoginFailure(key, secondStart)
	if second.Sub(secondStart) != 2*loginLockBaseDelay {
		t.Fatalf("second lock delay = %s", second.Sub(secondStart))
	}
	clearLoginFailures(key)
	if _, locked := loginLockedUntil(key, second.Add(-time.Millisecond)); locked {
		t.Fatal("cleared login failures still block authentication")
	}

	for i := 0; i < maxLoginAttemptKeys+128; i++ {
		recordLoginFailure(fmt.Sprintf("user-%d|127.0.0.1", i), started.Add(time.Duration(i)*time.Millisecond))
	}
	authRuntime.mu.Lock()
	count := len(authRuntime.loginAttempts)
	authRuntime.mu.Unlock()
	if count > maxLoginAttemptKeys {
		t.Fatalf("tracked login keys = %d, limit %d", count, maxLoginAttemptKeys)
	}
}

func TestAuthRedirectAndPagePrivacyContract(t *testing.T) {
	redirects := []struct{ raw, want string }{
		{"", "/"},
		{"/music/search?q=test", "/"},
		{"/music/render", "/"},
		{"/music/login", "/"},
		{"/music/setup", "/"},
		{"/music", "/"},
		{"/music/", "/"},
		{"/other", "/other"},
		{"other", "/"},
		{"https://example.com/music", "/"},
		{"//example.com/music", "/"},
		{`\\example.com/music`, "/"},
		{"/%5c%5cexample.com/music", "/"},
		{"///example.com/music", "/"},
	}
	for _, tc := range redirects {
		if got := safeAuthRedirectTarget(tc.raw); got != tc.want {
			t.Fatalf("safe redirect for %q = %q, want %q", tc.raw, got, tc.want)
		}
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET(RoutePrefix+"/login", func(c *gin.Context) { renderAuthPage(c, "login", "", "private-owner") })
	router.GET(RoutePrefix+"/setup", func(c *gin.Context) { renderAuthPage(c, "setup", "", "setup-owner") })

	login := httptest.NewRecorder()
	router.ServeHTTP(login, httptest.NewRequest(http.MethodGet, RoutePrefix+"/login", nil))
	if login.Code != http.StatusOK || strings.Contains(login.Body.String(), "private-owner") || strings.Contains(login.Body.String(), `name="username" value=`) {
		t.Fatalf("login page leaked configured identity: status=%d", login.Code)
	}
	if !strings.Contains(login.Body.String(), `name="username"`) || !strings.Contains(login.Body.String(), `autocomplete="off"`) {
		t.Fatal("login username field does not disable autocomplete")
	}

	setup := httptest.NewRecorder()
	router.ServeHTTP(setup, httptest.NewRequest(http.MethodGet, RoutePrefix+"/setup", nil))
	if setup.Code != http.StatusOK || !strings.Contains(setup.Body.String(), `name="username" value="setup-owner" autocomplete="username"`) {
		t.Fatalf("setup page did not retain the submitted username: status=%d", setup.Code)
	}
}

func TestSaveLocalWriteGuardContract(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct {
		name, method, origin, xhr, expected string
		withUser                            bool
		status                              int
		allow                               bool
		code                                string
	}{
		{"GET", http.MethodGet, "", "XMLHttpRequest", "", false, http.StatusMethodNotAllowed, false, ""},
		{"no XHR", http.MethodPost, "", "", "", false, http.StatusForbidden, false, ""},
		{"cross origin", http.MethodPost, "https://evil.example", "XMLHttpRequest", "", false, http.StatusForbidden, false, ""},
		{"anonymous", http.MethodPost, "http://example.test", "XMLHttpRequest", "", false, http.StatusUnauthorized, false, ""},
		{"authenticated", http.MethodPost, "http://example.test", "XMLHttpRequest", "", true, 0, true, ""},
		{"matching user", http.MethodPost, "http://example.test", "XMLHttpRequest", "1", true, 0, true, ""},
		{"changed user", http.MethodPost, "http://example.test", "XMLHttpRequest", "2", true, http.StatusConflict, false, "user_changed"},
		{"invalid user", http.MethodPost, "http://example.test", "XMLHttpRequest", "not-a-user", true, http.StatusBadRequest, false, "invalid_expected_user"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			request := httptest.NewRequest(tc.method, "http://example.test"+RoutePrefix+"/download?save_local=1", nil)
			if tc.origin != "" {
				request.Header.Set("Origin", tc.origin)
			}
			if tc.xhr != "" {
				request.Header.Set("X-Requested-With", tc.xhr)
			}
			if tc.expected != "" {
				request.Header.Set(expectedSaveUserHeader, tc.expected)
			}
			ctx.Request = request
			if tc.withUser {
				ctx.Set(ctxUserID, uint(1))
				ctx.Set(ctxUserRole, RoleUser)
			}
			if got := allowSaveLocalRequest(ctx); got != tc.allow {
				t.Fatalf("allow = %v, want %v", got, tc.allow)
			}
			if !tc.allow && recorder.Code != tc.status {
				t.Fatalf("status = %d, want %d", recorder.Code, tc.status)
			}
			if tc.code != "" && !strings.Contains(recorder.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("response = %s, want code %q", recorder.Body.String(), tc.code)
			}
		})
	}
}

func TestCORSContractForPlaybackAndSaveHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(corsMiddleware())
	router.OPTIONS("/test", func(c *gin.Context) { c.Status(http.StatusOK) })
	request := httptest.NewRequest(http.MethodOptions, "http://example.test/test", nil)
	request.Header.Set("Origin", "http://example.test")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d", recorder.Code)
	}
	if allowed := recorder.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(allowed, expectedSaveUserHeader) {
		t.Fatalf("allowed headers = %q", allowed)
	}
	exposed := recorder.Header().Get("Access-Control-Expose-Headers")
	for _, header := range []string{"X-Melodex-Playback-Source", "X-Melodex-Chunk-Index", "X-Melodex-Chunk-Final"} {
		if !strings.Contains(exposed, header) {
			t.Fatalf("exposed headers = %q, missing %q", exposed, header)
		}
	}
}

func TestAuthenticationMiddlewareContract(t *testing.T) {
	t.Run("setup redirect", func(t *testing.T) {
		setupUserTestDB(t)
		router := gin.New()
		router.Use(authRequired())
		router.GET(RoutePrefix, func(c *gin.Context) { c.String(http.StatusOK, "ok") })
		request := httptest.NewRequest(http.MethodGet, RoutePrefix, nil)
		request.Header.Set("Accept", "text/html")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusFound || recorder.Header().Get("Location") != RoutePrefix+"/setup" {
			t.Fatalf("setup redirect = %d %q", recorder.Code, recorder.Header().Get("Location"))
		}
	})

	t.Run("signed session", func(t *testing.T) {
		setupUserTestDB(t)
		user, err := createUser("owner", "ownerpass1", RoleUser)
		if err != nil {
			t.Fatalf("create user: %v", err)
		}
		value, err := createUserSession(user, time.Now())
		if err != nil {
			t.Fatalf("create session: %v", err)
		}
		router := gin.New()
		router.Use(authRequired())
		router.GET("/secure", func(c *gin.Context) { c.String(http.StatusOK, c.GetString(ctxUsername)) })
		request := httptest.NewRequest(http.MethodGet, "/secure", nil)
		request.AddCookie(&http.Cookie{Name: authCookieName, Value: value})
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK || recorder.Body.String() != "owner" {
			t.Fatalf("authenticated response = %d %q", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("backend error keeps cookie", func(t *testing.T) {
		setupUserTestDB(t)
		user, err := createUser("owner", "ownerpass1", RoleUser)
		if err != nil {
			t.Fatalf("create user: %v", err)
		}
		value := encodeSessionForContract(t, user, "sekret", time.Now())
		core.ResetConfigStateForTest()
		resetAuthRuntimeForTest()
		t.Cleanup(func() {
			core.ResetConfigStateForTest()
			resetAuthRuntimeForTest()
		})
		t.Setenv(core.DatabaseDriverEnv, "unsupported")
		router := gin.New()
		router.Use(authRequired())
		router.GET("/secure", func(c *gin.Context) { c.String(http.StatusOK, "ok") })
		request := httptest.NewRequest(http.MethodGet, "/secure", nil)
		request.Header.Set("Accept", "application/json")
		request.AddCookie(&http.Cookie{Name: authCookieName, Value: value})
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("backend error status = %d, body=%s", recorder.Code, recorder.Body.String())
		}
		for _, cookie := range recorder.Result().Cookies() {
			if cookie.Name == authCookieName {
				t.Fatalf("backend error cleared auth cookie: %+v", cookie)
			}
		}
	})

	t.Run("admin boundary", func(t *testing.T) {
		setupUserTestDB(t)
		user, err := createUser("plainuser", "userpass1", RoleUser)
		if err != nil {
			t.Fatalf("create user: %v", err)
		}
		value, err := createUserSession(user, time.Now())
		if err != nil {
			t.Fatalf("create session: %v", err)
		}
		router := gin.New()
		group := router.Group("")
		group.Use(authRequired(), adminRequired())
		group.GET("/admin-only", func(c *gin.Context) { c.String(http.StatusOK, "secret") })
		request := httptest.NewRequest(http.MethodGet, "/admin-only", nil)
		request.Header.Set("Accept", "application/json")
		request.AddCookie(&http.Cookie{Name: authCookieName, Value: value})
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("non-admin status = %d", recorder.Code)
		}
	})

	t.Run("desktop bypass", func(t *testing.T) {
		setupUserTestDB(t)
		router := gin.New()
		api := router.Group(RoutePrefix)
		_, userAPI := bindAuthMiddleware(api, StartOptions{DisableAuth: true})
		userAPI.GET("", func(c *gin.Context) { c.String(http.StatusOK, "desktop") })
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, RoutePrefix, nil))
		if recorder.Code != http.StatusOK || recorder.Body.String() != "desktop" {
			t.Fatalf("desktop response = %d %q", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("config-only protection", func(t *testing.T) {
		setupUserTestDB(t)
		if _, err := createUser("owner", "ownerpass1", RoleAdmin); err != nil {
			t.Fatalf("create admin: %v", err)
		}
		router := newConfigProtectionContractRouter()
		if status := authContractRequestStatus(router, http.MethodGet, RoutePrefix); status != http.StatusOK {
			t.Fatalf("public status = %d", status)
		}
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			status := authContractRequestStatus(router, method, RoutePrefix+"/cookies")
			if status != http.StatusUnauthorized {
				t.Fatalf("%s config status = %d", method, status)
			}
		}
	})
}

func newConfigProtectionContractRouter() *gin.Engine {
	router := gin.New()
	root := router.Group(RoutePrefix)
	root.GET("", func(c *gin.Context) { c.String(http.StatusOK, "public") })
	protected := root.Group("")
	protected.Use(authRequired())
	protected.Use(adminRequired())
	protected.GET("/cookies", func(c *gin.Context) { c.String(http.StatusOK, "config") })
	protected.HEAD("/cookies", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	return router
}

func authContractRequestStatus(router http.Handler, method, path string) int {
	request := httptest.NewRequest(method, path, nil)
	request.Header.Set("Accept", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder.Code
}

func encodeSessionForContract(t *testing.T, user *User, secret string, issuedAt time.Time) string {
	t.Helper()
	payload, err := json.Marshal(sessionPayload{UserID: user.ID, Username: user.Username, Epoch: user.SessionEpoch, IssuedAt: issuedAt.Unix(), Nonce: "contract-nonce"})
	if err != nil {
		t.Fatalf("encode session payload: %v", err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	return encoded + "." + signSessionPayload(secret, encoded)
}

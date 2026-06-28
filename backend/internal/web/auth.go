package web

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/guohuiyuan/go-music-dl/core"
	"golang.org/x/crypto/bcrypt"
)

const (
	authCookieName      = "music_dl_session"
	sessionMaxAge       = 7 * 24 * time.Hour
	minAuthPasswordSize = 6
	setupTokenBytes     = 24
	loginLockBaseDelay  = time.Second
	loginLockMaxDelay   = time.Minute
)

var authRuntime = newAuthRuntimeState()

type sessionPayload struct {
	UserID   uint   `json:"uid"`
	Username string `json:"u"`
	IssuedAt int64  `json:"iat"`
	Nonce    string `json:"n"`
}

type loginAttemptState struct {
	Failures    int
	LockedUntil time.Time
}

type authRuntimeState struct {
	mu            sync.Mutex
	setupToken    string
	loginAttempts map[string]loginAttemptState
}

func newAuthRuntimeState() *authRuntimeState {
	return &authRuntimeState{
		loginAttempts: make(map[string]loginAttemptState),
	}
}

func resetAuthRuntimeForTest() {
	authRuntime = newAuthRuntimeState()
}

// prepareSetupToken 在系统尚无任何用户时生成一次性初始化令牌(用于首个管理员 setup)。
// configured=true(已存在用户)则不生成并清空。
func prepareSetupToken(configured bool) (string, error) {
	authRuntime.mu.Lock()
	defer authRuntime.mu.Unlock()

	if configured {
		authRuntime.setupToken = ""
		return "", nil
	}
	if authRuntime.setupToken != "" {
		return authRuntime.setupToken, nil
	}
	token, err := randomToken(setupTokenBytes)
	if err != nil {
		return "", err
	}
	authRuntime.setupToken = token
	return token, nil
}

func currentSetupToken() string {
	authRuntime.mu.Lock()
	defer authRuntime.mu.Unlock()
	return authRuntime.setupToken
}

func consumeSetupToken() {
	authRuntime.mu.Lock()
	defer authRuntime.mu.Unlock()
	authRuntime.setupToken = ""
}

func loginAttemptKey(c *gin.Context, username string) string {
	ip := "unknown"
	if c != nil {
		ip = c.ClientIP()
	}
	return strings.ToLower(strings.TrimSpace(username)) + "|" + ip
}

func loginLockDelay(failures int) time.Duration {
	if failures <= 0 {
		return 0
	}
	delay := loginLockBaseDelay << min(failures-1, 6)
	if delay > loginLockMaxDelay {
		return loginLockMaxDelay
	}
	return delay
}

func loginLockedUntil(key string, now time.Time) (time.Time, bool) {
	authRuntime.mu.Lock()
	defer authRuntime.mu.Unlock()
	attempt := authRuntime.loginAttempts[key]
	if attempt.LockedUntil.After(now) {
		return attempt.LockedUntil, true
	}
	return time.Time{}, false
}

func recordLoginFailure(key string, now time.Time) time.Time {
	authRuntime.mu.Lock()
	defer authRuntime.mu.Unlock()

	attempt := authRuntime.loginAttempts[key]
	attempt.Failures++
	attempt.LockedUntil = now.Add(loginLockDelay(attempt.Failures))
	authRuntime.loginAttempts[key] = attempt
	return attempt.LockedUntil
}

func clearLoginFailures(key string) {
	authRuntime.mu.Lock()
	defer authRuntime.mu.Unlock()
	delete(authRuntime.loginAttempts, key)
}

func randomToken(byteLen int) (string, error) {
	buf := make([]byte, byteLen)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// signingSecret 返回全局会话签名密钥(HMAC-SHA256)。多用户共用同一签名密钥,
// 用户身份由 payload 内的 UserID 区分。密钥存在 WebAuthSettings.SessionSecret,
// 首次调用若缺失则生成并持久化(幂等)。
func signingSecret() (string, error) {
	settings, err := core.GetWebAuthSettings()
	if err != nil {
		return "", err
	}
	if s := strings.TrimSpace(settings.SessionSecret); s != "" {
		return s, nil
	}
	secret, err := randomToken(32)
	if err != nil {
		return "", err
	}
	settings.SessionSecret = secret
	if err := core.SaveWebAuthSettings(settings); err != nil {
		return "", err
	}
	return secret, nil
}

// createUserSession 为已认证用户签发会话(HMAC 签名 + 过期由 IssuedAt 控制)。
func createUserSession(u *User, now time.Time) (string, error) {
	if u == nil || u.ID == 0 {
		return "", fmt.Errorf("invalid user for session")
	}
	secret, err := signingSecret()
	if err != nil {
		return "", err
	}
	nonce, err := randomToken(18)
	if err != nil {
		return "", err
	}
	payload := sessionPayload{
		UserID:   u.ID,
		Username: u.Username,
		IssuedAt: now.Unix(),
		Nonce:    nonce,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	encodedPayload := base64.RawURLEncoding.EncodeToString(raw)
	signature := signSessionPayload(secret, encodedPayload)
	return encodedPayload + "." + signature, nil
}

func signSessionPayload(secret string, encodedPayload string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(encodedPayload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// parseSessionValue 验签并解析会话(不查库)。返回 payload 与是否有效。
// 仅校验签名与时间窗口;用户是否存在/被禁用由调用方查库判定。
func parseSessionValue(secret, value string, now time.Time) (sessionPayload, bool) {
	var payload sessionPayload
	if strings.TrimSpace(secret) == "" {
		return payload, false
	}
	parts := strings.Split(value, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return payload, false
	}
	expectedSig := signSessionPayload(secret, parts[0])
	if subtle.ConstantTimeCompare([]byte(parts[1]), []byte(expectedSig)) != 1 {
		return payload, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return payload, false
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return payload, false
	}
	if payload.UserID == 0 || payload.IssuedAt <= 0 || strings.TrimSpace(payload.Nonce) == "" {
		return payload, false
	}
	issuedAt := time.Unix(payload.IssuedAt, 0)
	if issuedAt.After(now.Add(2*time.Minute)) || now.Sub(issuedAt) > sessionMaxAge {
		return payload, false
	}
	return payload, true
}

// isSecureRequest 判断请求是否经 HTTPS 到达。直连看 TLS;经反代(NPM/ESA 终止 TLS)时
// 读 X-Forwarded-Proto。用于给会话 cookie 置 Secure,防止明文链路回传 cookie。
func isSecureRequest(c *gin.Context) bool {
	if c.Request.TLS != nil {
		return true
	}
	proto := c.GetHeader("X-Forwarded-Proto")
	return strings.EqualFold(strings.TrimSpace(strings.Split(proto, ",")[0]), "https")
}

func setAuthCookie(c *gin.Context, value string) {
	c.SetSameSite(http.SameSiteLaxMode)
	// Path 用 "/" 而非 RoutePrefix:登录态需覆盖 React(/)与 /api/* 接口,
	// 否则跳回根后 React 调 /api/* 带不上鉴权 cookie → 表现为"没登录"。
	c.SetCookie(authCookieName, value, int(sessionMaxAge.Seconds()), "/", "", isSecureRequest(c), true)
}

func clearAuthCookie(c *gin.Context) {
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(authCookieName, "", -1, "/", "", isSecureRequest(c), true)
}

func safeAuthRedirectTarget(raw string) string {
	// Melodex:登录/初始化成功后默认回到 React 应用根路径 "/",
	// 不再回老的 RoutePrefix(/music 已下线)。仅接受站内相对路径。
	const defaultTarget = "/"
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return defaultTarget
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.IsAbs() || strings.HasPrefix(raw, "//") {
		return defaultTarget
	}
	if parsed.Path == "" {
		return defaultTarget
	}
	// 不允许跳回登录/初始化页自身(会成环)
	if parsed.Path == RoutePrefix+"/login" || parsed.Path == RoutePrefix+"/setup" {
		return defaultTarget
	}
	// 老的 /music 首页已下线,跳它没意义 → 回根
	if parsed.Path == RoutePrefix {
		return defaultTarget
	}
	return parsed.String()
}

func loginRedirectTarget(c *gin.Context) string {
	target := c.Request.URL.RequestURI()
	return RoutePrefix + "/login?next=" + url.QueryEscape(safeAuthRedirectTarget(target))
}

func wantsHTML(c *gin.Context) bool {
	if c.GetHeader("X-Requested-With") == "XMLHttpRequest" {
		return false
	}
	accept := c.GetHeader("Accept")
	return accept == "" || strings.Contains(accept, "text/html")
}

// Context keys for the authenticated user.
const (
	ctxUserID   = "AuthUserID"
	ctxUserRole = "AuthUserRole"
	ctxUsername = "AuthUsername"
)

// setCurrentUser 把已认证用户写入请求上下文,供下游 handler 按 user_id 过滤数据
// 与判定角色。绝不信任前端传入的 user_id,一切以此上下文为准。
func setCurrentUser(c *gin.Context, u *User) {
	if u == nil {
		return
	}
	c.Set(ctxUserID, u.ID)
	c.Set(ctxUserRole, u.normalizedRole())
	c.Set(ctxUsername, u.Username)
}

// currentUserID 返回当前请求用户 id(0 表示未认证)。
func currentUserID(c *gin.Context) uint {
	if v, ok := c.Get(ctxUserID); ok {
		if id, ok := v.(uint); ok {
			return id
		}
	}
	return 0
}

func currentUserRole(c *gin.Context) string {
	if v, ok := c.Get(ctxUserRole); ok {
		if role, ok := v.(string); ok {
			return role
		}
	}
	return ""
}

// currentUserIsAdmin 当前用户是否管理员。
func currentUserIsAdmin(c *gin.Context) bool {
	return currentUserRole(c) == RoleAdmin
}

// authRequired 校验会话并把用户写入上下文。未初始化(无任何用户)时引导 setup,
// 会话无效/用户被禁用/已删除时引导登录或返回 401。
func authRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		n, err := countUsers()
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "读取账号配置失败"})
			return
		}
		if n == 0 {
			if wantsHTML(c) {
				c.Redirect(http.StatusFound, RoutePrefix+"/setup")
			} else {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "请先初始化管理员账号", "setupRequired": true})
			}
			c.Abort()
			return
		}

		if u, ok := authenticateRequest(c, time.Now()); ok {
			setCurrentUser(c, u)
			c.Next()
			return
		}

		clearAuthCookie(c)
		if wantsHTML(c) {
			c.Redirect(http.StatusFound, loginRedirectTarget(c))
		} else {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
		}
		c.Abort()
	}
}

// authenticateRequest 验签会话 cookie 并查库确认用户存在且未禁用。
func authenticateRequest(c *gin.Context, now time.Time) (*User, bool) {
	value, err := c.Cookie(authCookieName)
	if err != nil || value == "" {
		return nil, false
	}
	secret, err := signingSecret()
	if err != nil {
		return nil, false
	}
	payload, ok := parseSessionValue(secret, value, now)
	if !ok {
		return nil, false
	}
	u, err := findUserByID(payload.UserID)
	if err != nil || u == nil {
		return nil, false
	}
	if u.Disabled {
		return nil, false
	}
	// 用户名变更则旧会话失效(防止改名后旧 cookie 仍显示旧名)。
	if u.Username != payload.Username {
		return nil, false
	}
	return u, true
}

// adminRequired 必须在 authRequired 之后使用:非管理员返回 403。
func adminRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		if currentUserID(c) == 0 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
			return
		}
		if !currentUserIsAdmin(c) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "需要管理员权限"})
			return
		}
		c.Next()
	}
}

// attachUserOptional 非阻塞地注入当前用户(若存在有效会话)。用于公开读路由
// (搜索/播放/歌词等)上的 handler 需要可选地知道"当前是谁"(如下载记归属),
// 但不强制登录。无有效会话则不写入上下文,继续放行。
func attachUserOptional() gin.HandlerFunc {
	return func(c *gin.Context) {
		if u, ok := authenticateRequest(c, time.Now()); ok {
			setCurrentUser(c, u)
		}
		c.Next()
	}
}

// desktopUserMiddleware 桌面/本机模式:注入本地管理员用户,跳过登录。
// 数据仍按该用户 user_id 归属,保持与多用户模式同一套查询路径。
func desktopUserMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		u, err := ensureDesktopUser()
		if err != nil || u == nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "初始化本地用户失败"})
			return
		}
		setCurrentUser(c, u)
		c.Next()
	}
}


func renderAuthPage(c *gin.Context, mode string, errMsg string, username string) {
	title := "登录 Melodex"
	action := RoutePrefix + "/login"
	button := "登录"
	if mode == "setup" {
		title = "初始化管理员账号"
		action = RoutePrefix + "/setup"
		button = "创建账号"
	}

	c.HTML(http.StatusOK, "auth.html", gin.H{
		"Root":     RoutePrefix,
		"Title":    title,
		"Mode":     mode,
		"Action":   action,
		"Button":   button,
		"Error":    errMsg,
		"Username": username,
		"Next":     safeAuthRedirectTarget(c.Query("next")),
	})
}

func bindAuthRoutes(api *gin.RouterGroup) {
	api.GET("/setup", func(c *gin.Context) {
		n, err := countUsers()
		if err != nil {
			renderAuthPage(c, "setup", "读取账号配置失败", core.DefaultWebAuthUsername)
			return
		}
		if n > 0 {
			c.Redirect(http.StatusFound, RoutePrefix+"/login")
			return
		}
		renderAuthPage(c, "setup", "", core.DefaultWebAuthUsername)
	})

	api.POST("/setup", func(c *gin.Context) {
		n, err := countUsers()
		if err != nil {
			renderAuthPage(c, "setup", "读取账号配置失败", core.DefaultWebAuthUsername)
			return
		}
		if n > 0 {
			c.Redirect(http.StatusFound, RoutePrefix+"/login")
			return
		}

		username := strings.TrimSpace(c.PostForm("username"))
		password := c.PostForm("password")
		confirm := c.PostForm("password_confirm")
		if username == "" {
			renderAuthPage(c, "setup", "请输入用户名", username)
			return
		}
		setupToken := currentSetupToken()
		if setupToken == "" || subtle.ConstantTimeCompare([]byte(c.PostForm("setup_token")), []byte(setupToken)) != 1 {
			renderAuthPage(c, "setup", "初始化令牌不正确，请查看启动终端输出", username)
			return
		}
		if len(password) < minAuthPasswordSize {
			renderAuthPage(c, "setup", fmt.Sprintf("密码至少需要 %d 位", minAuthPasswordSize), username)
			return
		}
		if password != confirm {
			renderAuthPage(c, "setup", "两次输入的密码不一致", username)
			return
		}

		// 首个账号即 ROOT 管理员。
		root, err := createUser(username, password, RoleAdmin)
		if err != nil {
			renderAuthPage(c, "setup", setupErrorMessage(err), username)
			return
		}
		consumeSetupToken()
		sessionValue, err := createUserSession(root, time.Now())
		if err != nil {
			renderAuthPage(c, "setup", "创建登录会话失败", username)
			return
		}
		setAuthCookie(c, sessionValue)
		c.Redirect(http.StatusFound, safeAuthRedirectTarget(c.PostForm("next")))
	})

	api.GET("/login", func(c *gin.Context) {
		n, err := countUsers()
		if err != nil {
			renderAuthPage(c, "login", "读取账号配置失败", "")
			return
		}
		if n == 0 {
			c.Redirect(http.StatusFound, RoutePrefix+"/setup")
			return
		}
		if _, ok := authenticateRequest(c, time.Now()); ok {
			c.Redirect(http.StatusFound, safeAuthRedirectTarget(c.Query("next")))
			return
		}
		renderAuthPage(c, "login", "", "")
	})

	api.POST("/login", func(c *gin.Context) {
		n, err := countUsers()
		if err != nil {
			renderAuthPage(c, "login", "读取账号配置失败", "")
			return
		}
		if n == 0 {
			c.Redirect(http.StatusFound, RoutePrefix+"/setup")
			return
		}

		username := strings.TrimSpace(c.PostForm("username"))
		password := c.PostForm("password")
		attemptKey := loginAttemptKey(c, username)
		now := time.Now()
		if lockedUntil, locked := loginLockedUntil(attemptKey, now); locked {
			wait := int(time.Until(lockedUntil).Seconds()) + 1
			renderAuthPage(c, "login", fmt.Sprintf("登录失败次数过多，请 %d 秒后重试", wait), username)
			return
		}

		user, ok := authenticateCredentials(username, password)
		if !ok {
			lockedUntil := recordLoginFailure(attemptKey, now)
			wait := int(time.Until(lockedUntil).Seconds()) + 1
			if wait > 1 {
				renderAuthPage(c, "login", fmt.Sprintf("用户名或密码不正确，请 %d 秒后重试", wait), username)
				return
			}
			renderAuthPage(c, "login", "用户名或密码不正确", username)
			return
		}
		clearLoginFailures(attemptKey)

		sessionValue, err := createUserSession(user, time.Now())
		if err != nil {
			renderAuthPage(c, "login", "创建登录会话失败", username)
			return
		}
		setAuthCookie(c, sessionValue)
		c.Redirect(http.StatusFound, safeAuthRedirectTarget(c.PostForm("next")))
	})

	api.POST("/logout", func(c *gin.Context) {
		clearAuthCookie(c)
		c.Redirect(http.StatusFound, "/")
	})
}

// authenticateCredentials 校验用户名+密码,返回用户与是否成功。
// 用 bcrypt 常量时间比对;用户不存在时也跑一次假哈希比对,避免时序侧信道泄露用户是否存在。
func authenticateCredentials(username, password string) (*User, bool) {
	u, err := findUserByUsername(username)
	if err != nil || u == nil {
		// 防用户名枚举时序攻击:对不存在的用户也消耗一次 bcrypt。
		_ = bcrypt.CompareHashAndPassword([]byte(dummyBcryptHash), []byte(password))
		return nil, false
	}
	if u.Disabled {
		return nil, false
	}
	if !verifyPassword(u.PasswordHash, password) {
		return nil, false
	}
	return u, true
}

// dummyBcryptHash 是一个合法的 bcrypt 哈希(明文 "x"),仅用于登录时序防护。
const dummyBcryptHash = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"

func setupErrorMessage(err error) string {
	switch {
	case errors.Is(err, ErrInvalidUsername):
		return "用户名需 2-32 个字符且不含空白"
	case errors.Is(err, ErrInvalidPassword):
		return fmt.Sprintf("密码至少需要 %d 位", minAuthPasswordSize)
	case errors.Is(err, ErrUsernameTaken):
		return "用户名已存在"
	default:
		return "创建账号失败"
	}
}

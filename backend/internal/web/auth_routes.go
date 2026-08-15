package web

import (
	"bytes"
	"crypto/subtle"
	"fmt"
	"html/template"
	"net/http"
	"strings"
	"time"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

var authPageView = template.Must(template.New("auth").Parse(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>{{.Title}}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px 20px;background:#f5f5f5;color:#242424;font-family:Arial,"Microsoft YaHei",sans-serif}
    main{width:min(420px,100%)}section{background:rgba(255,255,255,.96);border:1px solid #e3e3e3;border-radius:4px;padding:34px;box-shadow:0 8px 24px rgba(0,0,0,.12)}
    .brand{display:inline-flex;align-items:center;gap:8px;margin-bottom:18px;color:#0078d4;text-decoration:none;font-weight:800}.mark{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#0078d4;color:#fff;font-size:13px}
    h1{margin:0 0 10px;font-size:29px}.hint{margin:0 0 24px;color:#666;font-size:14px;line-height:1.6}.error{margin-bottom:18px;padding:11px 12px;border-left:3px solid #c42b1c;background:#fde7e9;color:#8a1c13;font-size:14px}
    form{display:flex;flex-direction:column;gap:16px}label{display:flex;flex-direction:column;gap:8px;font-size:14px;font-weight:700}input{width:100%;min-height:42px;border:1px solid #8a8886;border-radius:2px;padding:9px 11px;font:inherit}input:focus{outline:2px solid #0078d4;outline-offset:1px}
    button{min-height:48px;margin-top:6px;border:0;border-radius:2px;background:#0078d4;color:#fff;font:700 15px inherit;cursor:pointer}button:hover{background:#106ebe}button:focus-visible{outline:2px solid #111;outline-offset:2px}
    @media(max-width:520px){body{padding:24px 14px}section{padding:26px 20px}}
  </style>
</head>
<body>
<main><section>
  <a class="brand" href="https://github.com/aki-riko/Melodex" target="_blank" rel="noopener"><span class="mark">M</span><span>Melodex</span></a>
  <h1>{{.Title}}</h1>
  {{if eq .Mode "setup"}}<p class="hint">首次使用需要创建本地管理员账号，用来保护平台 Cookie 和系统设置。</p>{{else}}<p class="hint">请输入 Melodex 账号继续。</p>{{end}}
  {{if .Error}}<div class="error" role="alert">{{.Error}}</div>{{end}}
  <form method="post" action="{{.Action}}">
    <input type="hidden" name="next" value="{{.Next}}">
    {{if eq .Mode "setup"}}<label><span>初始化令牌</span><input type="text" name="setup_token" autocomplete="off" required></label>{{end}}
    <label><span>用户名</span><input type="text" name="username"{{if eq .Mode "setup"}} value="{{.Username}}" autocomplete="username"{{else}} autocomplete="off"{{end}} required autofocus></label>
    <label><span>密码</span><input type="password" name="password" autocomplete="{{if eq .Mode "setup"}}new-password{{else}}current-password{{end}}" minlength="8" required></label>
    {{if eq .Mode "setup"}}<label><span>确认密码</span><input type="password" name="password_confirm" autocomplete="new-password" minlength="8" required></label>{{end}}
    <button type="submit">{{.Button}}</button>
  </form>
</section></main>
</body>
</html>`))

type authPageData struct {
	Title    string
	Mode     string
	Action   string
	Button   string
	Error    string
	Username string
	Next     string
}

func renderAuthPage(c *gin.Context, mode, errorMessage, username string) {
	view := authPageData{
		Title: "登录 Melodex", Mode: mode, Action: RoutePrefix + "/login",
		Button: "登录", Error: errorMessage, Next: safeAuthRedirectTarget(c.Query("next")),
	}
	if mode == "setup" {
		view.Title = "初始化管理员账号"
		view.Action = RoutePrefix + "/setup"
		view.Button = "创建账号"
		view.Username = username
	}
	var body bytes.Buffer
	if err := authPageView.Execute(&body, view); err != nil {
		c.String(http.StatusInternalServerError, "登录页面生成失败")
		return
	}
	c.Data(http.StatusOK, "text/html; charset=utf-8", body.Bytes())
}

func bindAuthRoutes(api *gin.RouterGroup) {
	api.GET("/setup", setupPageRoute)
	api.POST("/setup", setupFormRoute)
	api.GET("/login", loginPageRoute)
	api.POST("/login", loginFormRoute)
	api.POST("/logout", logoutFormRoute)
}

func setupPageRoute(c *gin.Context) {
	users, err := countUsers()
	if err != nil {
		renderAuthPage(c, "setup", "读取账号配置失败", core.DefaultWebAuthUsername)
		return
	}
	if users > 0 {
		c.Redirect(http.StatusFound, RoutePrefix+"/login")
		return
	}
	renderAuthPage(c, "setup", "", core.DefaultWebAuthUsername)
}

func setupFormRoute(c *gin.Context) {
	users, err := countUsers()
	if err != nil {
		renderAuthPage(c, "setup", "读取账号配置失败", core.DefaultWebAuthUsername)
		return
	}
	if users > 0 {
		c.Redirect(http.StatusFound, RoutePrefix+"/login")
		return
	}
	username := strings.TrimSpace(c.PostForm("username"))
	password := c.PostForm("password")
	if username == "" {
		renderAuthPage(c, "setup", "请输入用户名", username)
		return
	}
	configuredToken := currentSetupToken()
	providedToken := c.PostForm("setup_token")
	tokenMatches := configuredToken != "" && subtle.ConstantTimeCompare([]byte(providedToken), []byte(configuredToken)) == 1
	if !tokenMatches {
		renderAuthPage(c, "setup", "初始化令牌不正确，请查看启动终端输出", username)
		return
	}
	passwordTooShort := len(password) < minAuthPasswordSize
	if passwordTooShort {
		renderAuthPage(c, "setup", fmt.Sprintf("密码至少需要 %d 位", minAuthPasswordSize), username)
		return
	}
	if password != c.PostForm("password_confirm") {
		renderAuthPage(c, "setup", "两次输入的密码不一致", username)
		return
	}
	root, err := createUser(username, password, RoleAdmin)
	if err != nil {
		renderAuthPage(c, "setup", setupErrorMessage(err), username)
		return
	}
	consumeSetupToken()
	completeHTMLLogin(c, root, username, c.PostForm("next"), "setup")
}

func loginPageRoute(c *gin.Context) {
	users, err := countUsers()
	if err != nil {
		renderAuthPage(c, "login", "读取账号配置失败", "")
		return
	}
	if users == 0 {
		c.Redirect(http.StatusFound, RoutePrefix+"/setup")
		return
	}
	if _, valid, err := authenticateRequest(c, time.Now()); err != nil {
		c.String(http.StatusServiceUnavailable, "登录状态校验失败,请稍后重试")
		return
	} else if valid {
		c.Redirect(http.StatusFound, safeAuthRedirectTarget(c.Query("next")))
		return
	}
	renderAuthPage(c, "login", "", "")
}

func loginFormRoute(c *gin.Context) {
	users, err := countUsers()
	if err != nil {
		renderAuthPage(c, "login", "读取账号配置失败", "")
		return
	}
	if users == 0 {
		c.Redirect(http.StatusFound, RoutePrefix+"/setup")
		return
	}
	username := strings.TrimSpace(c.PostForm("username"))
	attemptKey := loginAttemptKey(c, username)
	now := time.Now()
	if lockedUntil, locked := loginLockedUntil(attemptKey, now); locked {
		renderAuthPage(c, "login", loginWaitMessage("登录失败次数过多", lockedUntil), username)
		return
	}
	user, valid := authenticateCredentials(username, c.PostForm("password"))
	if !valid {
		lockedUntil := recordLoginFailure(attemptKey, now)
		renderAuthPage(c, "login", loginWaitMessage("用户名或密码不正确", lockedUntil), username)
		return
	}
	clearLoginFailures(attemptKey)
	completeHTMLLogin(c, user, username, c.PostForm("next"), "login")
}

func loginWaitMessage(prefix string, lockedUntil time.Time) string {
	waitSeconds := max(int(time.Until(lockedUntil).Seconds())+1, 1)
	if waitSeconds <= 1 {
		return prefix
	}
	return fmt.Sprintf("%s，请 %d 秒后重试", prefix, waitSeconds)
}

func completeHTMLLogin(c *gin.Context, user *User, username, next, mode string) {
	session, err := createUserSession(user, time.Now())
	if err != nil {
		renderAuthPage(c, mode, "创建登录会话失败", username)
		return
	}
	setAuthCookie(c, session)
	c.Redirect(http.StatusFound, safeAuthRedirectTarget(next))
}

func logoutFormRoute(c *gin.Context) {
	clearAuthCookie(c)
	c.Redirect(http.StatusFound, "/")
}

const dummyBcryptHash = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"

func authenticateCredentials(username, password string) (*User, bool) {
	user, err := findUserByUsername(username)
	if err != nil || user == nil {
		_ = bcrypt.CompareHashAndPassword([]byte(dummyBcryptHash), []byte(password))
		return nil, false
	}
	passwordValid := verifyPassword(user.PasswordHash, password)
	if user.Disabled || !passwordValid {
		return nil, false
	}
	return user, true
}

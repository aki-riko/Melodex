package web

import (
	"crypto/subtle"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/guohuiyuan/go-music-dl/core"
)

const allowRegistrationKey = "allow_registration"

// registrationAllowed 返回是否开放自助注册(默认关闭)。
func registrationAllowed() bool {
	v, err := core.GetConfigValue(allowRegistrationKey)
	if err != nil {
		return false
	}
	return strings.TrimSpace(v) == "1"
}

func setRegistrationAllowed(allow bool) error {
	val := "0"
	if allow {
		val = "1"
	}
	return core.SetConfigValue(allowRegistrationKey, val)
}

// registerAuthAPIRoutes 注册 React 前端用的 JSON 鉴权接口(/api/v1/auth/* 与 /api/v1/me)。
// 这些接口本身处理登录态,不套 authRequired(login/setup/register 必须未登录可访问)。
func registerAuthAPIRoutes(api *gin.RouterGroup, opts StartOptions) {
	// 当前登录用户(前端启动时拉取以决定是否跳登录页 + 渲染角色相关 UI)。
	api.GET("/me", func(c *gin.Context) {
		// 桌面模式:注入本地用户。
		if opts.DisableAuth {
			if u, err := ensureDesktopUser(); err == nil && u != nil {
				c.JSON(http.StatusOK, gin.H{"user": u.public(), "allowRegistration": false, "desktop": true})
				return
			}
		}
		n, err := countUsers()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "读取账号配置失败"})
			return
		}
		if n == 0 {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "请先初始化管理员账号", "setupRequired": true})
			return
		}
		u, ok := authenticateRequest(c, time.Now())
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "请先登录", "allowRegistration": registrationAllowed()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"user": u.public(), "allowRegistration": registrationAllowed()})
	})

	// 初始化首个管理员(仅当系统无任何用户时可用)。
	api.POST("/auth/setup", func(c *gin.Context) {
		n, err := countUsers()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "读取账号配置失败"})
			return
		}
		if n > 0 {
			c.JSON(http.StatusConflict, gin.H{"error": "管理员已存在"})
			return
		}
		var req struct {
			Username   string `json:"username"`
			Password   string `json:"password"`
			SetupToken string `json:"setup_token"`
		}
		if c.ShouldBindJSON(&req) != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		// 与 HTML 版 setup 一致:校验启动终端打印的一次性初始化令牌,防止首次部署窗口内
		// 任意访问者抢先创建 ROOT 管理员。
		token := currentSetupToken()
		if token == "" || subtle.ConstantTimeCompare([]byte(req.SetupToken), []byte(token)) != 1 {
			c.JSON(http.StatusForbidden, gin.H{"error": "初始化令牌不正确,请查看服务启动终端输出"})
			return
		}
		root, err := createUser(req.Username, req.Password, RoleAdmin)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": setupErrorMessage(err)})
			return
		}
		consumeSetupToken()
		issueSessionResponse(c, root)
	})

	// 登录。
	api.POST("/auth/login", func(c *gin.Context) {
		var req struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if c.ShouldBindJSON(&req) != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		username := strings.TrimSpace(req.Username)
		attemptKey := loginAttemptKey(c, username)
		now := time.Now()
		if lockedUntil, locked := loginLockedUntil(attemptKey, now); locked {
			wait := int(time.Until(lockedUntil).Seconds()) + 1
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "登录失败次数过多，请稍后重试", "retryAfter": wait})
			return
		}
		user, ok := authenticateCredentials(username, req.Password)
		if !ok {
			recordLoginFailure(attemptKey, now)
			c.JSON(http.StatusUnauthorized, gin.H{"error": "用户名或密码不正确"})
			return
		}
		clearLoginFailures(attemptKey)
		issueSessionResponse(c, user)
	})

	// 自助注册(默认关闭;开放时创建普通用户)。
	api.POST("/auth/register", func(c *gin.Context) {
		if !registrationAllowed() {
			c.JSON(http.StatusForbidden, gin.H{"error": "当前未开放注册"})
			return
		}
		var req struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if c.ShouldBindJSON(&req) != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		// 注册接口也套失败限流,防爆破/刷号(按 IP)。
		attemptKey := loginAttemptKey(c, "register")
		now := time.Now()
		if lockedUntil, locked := loginLockedUntil(attemptKey, now); locked {
			wait := int(time.Until(lockedUntil).Seconds()) + 1
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "操作过于频繁，请稍后重试", "retryAfter": wait})
			return
		}
		user, err := createUser(req.Username, req.Password, RoleUser)
		if err != nil {
			recordLoginFailure(attemptKey, now)
			c.JSON(http.StatusBadRequest, gin.H{"error": setupErrorMessage(err)})
			return
		}
		clearLoginFailures(attemptKey)
		issueSessionResponse(c, user)
	})

	// 登出(清 cookie)。
	api.POST("/auth/logout", func(c *gin.Context) {
		clearAuthCookie(c)
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
}

// issueSessionResponse 签发会话 cookie 并返回脱敏用户。
func issueSessionResponse(c *gin.Context, u *User) {
	value, err := createUserSession(u, time.Now())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "创建登录会话失败"})
		return
	}
	setAuthCookie(c, value)
	c.JSON(http.StatusOK, gin.H{"user": u.public()})
}

// registerAdminUserRoutes 注册用户管理接口(管理员独占,调用方已套 authRequired+adminRequired)。
func registerAdminUserRoutes(api *gin.RouterGroup) {
	// 列出所有用户(脱敏)。
	api.GET("/admin/users", func(c *gin.Context) {
		users, err := listUsers()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "读取用户列表失败"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"users": users, "allowRegistration": registrationAllowed()})
	})

	// 管理员创建用户(可指定角色)。
	api.POST("/admin/users", func(c *gin.Context) {
		var req struct {
			Username string `json:"username"`
			Password string `json:"password"`
			Role     string `json:"role"`
		}
		if c.ShouldBindJSON(&req) != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		u, err := createUser(req.Username, req.Password, req.Role)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": setupErrorMessage(err)})
			return
		}
		c.JSON(http.StatusOK, gin.H{"user": u.public()})
	})

	// 改角色。
	api.PUT("/admin/users/:id/role", func(c *gin.Context) {
		id, ok := parseUserIDParam(c)
		if !ok {
			return
		}
		var req struct {
			Role string `json:"role"`
		}
		if c.ShouldBindJSON(&req) != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		// 防止管理员把自己降级导致失去最后一个管理员(setUserRole 已保护最后管理员,
		// 这里额外明确禁止自降以免误操作锁死)。
		if id == currentUserID(c) && req.Role != RoleAdmin {
			c.JSON(http.StatusBadRequest, gin.H{"error": "不能降级自己的管理员权限"})
			return
		}
		if err := setUserRole(id, req.Role); err != nil {
			c.JSON(userMgmtErrStatus(err), gin.H{"error": userMgmtErrMsg(err)})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// 启用/禁用。
	api.PUT("/admin/users/:id/disabled", func(c *gin.Context) {
		id, ok := parseUserIDParam(c)
		if !ok {
			return
		}
		var req struct {
			Disabled bool `json:"disabled"`
		}
		if c.ShouldBindJSON(&req) != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		if id == currentUserID(c) && req.Disabled {
			c.JSON(http.StatusBadRequest, gin.H{"error": "不能禁用自己"})
			return
		}
		if err := setUserDisabled(id, req.Disabled); err != nil {
			c.JSON(userMgmtErrStatus(err), gin.H{"error": userMgmtErrMsg(err)})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// 重置密码。
	api.PUT("/admin/users/:id/password", func(c *gin.Context) {
		id, ok := parseUserIDParam(c)
		if !ok {
			return
		}
		var req struct {
			Password string `json:"password"`
		}
		if c.ShouldBindJSON(&req) != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		if err := setUserPassword(id, req.Password); err != nil {
			c.JSON(userMgmtErrStatus(err), gin.H{"error": userMgmtErrMsg(err)})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// 删除用户(连同其归属数据:歌单 + 下载归属记录)。
	api.DELETE("/admin/users/:id", func(c *gin.Context) {
		id, ok := parseUserIDParam(c)
		if !ok {
			return
		}
		if id == currentUserID(c) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "不能删除自己"})
			return
		}
		if err := deleteUserAndData(id); err != nil {
			c.JSON(userMgmtErrStatus(err), gin.H{"error": userMgmtErrMsg(err)})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// 开放注册开关。
	api.PUT("/admin/registration", func(c *gin.Context) {
		var req struct {
			Allow bool `json:"allow"`
		}
		if c.ShouldBindJSON(&req) != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		if err := setRegistrationAllowed(req.Allow); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "保存失败"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"allowRegistration": req.Allow})
	})
}

func parseUserIDParam(c *gin.Context) (uint, bool) {
	raw := strings.TrimSpace(c.Param("id"))
	n, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || n == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的用户 id"})
		return 0, false
	}
	return uint(n), true
}

func userMgmtErrStatus(err error) int {
	switch {
	case err == ErrUserNotFound:
		return http.StatusNotFound
	case err == ErrLastRootProtected:
		return http.StatusBadRequest
	case err == ErrInvalidPassword, err == ErrInvalidUsername, err == ErrUsernameTaken:
		return http.StatusBadRequest
	default:
		return http.StatusInternalServerError
	}
}

func userMgmtErrMsg(err error) string {
	switch {
	case err == ErrUserNotFound:
		return "用户不存在"
	case err == ErrLastRootProtected:
		return "系统至少保留一个管理员"
	case err == ErrInvalidPassword:
		return "密码至少需要 6 位"
	case err == ErrInvalidUsername:
		return "用户名不合法"
	case err == ErrUsernameTaken:
		return "用户名已存在"
	default:
		return "操作失败"
	}
}


package web

import (
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	ctxUserID   = "AuthUserID"
	ctxUserRole = "AuthUserRole"
	ctxUsername = "AuthUsername"
)

func isSecureRequest(c *gin.Context) bool {
	if c.Request.TLS != nil {
		return true
	}
	forwarded := strings.Split(c.GetHeader("X-Forwarded-Proto"), ",")[0]
	return strings.EqualFold(strings.TrimSpace(forwarded), "https")
}

func setAuthCookie(c *gin.Context, value string) {
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(authCookieName, value, int(sessionMaxAge().Seconds()), "/", "", isSecureRequest(c), true)
}

func clearAuthCookie(c *gin.Context) {
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(authCookieName, "", -1, "/", "", isSecureRequest(c), true)
}

func safeAuthRedirectTarget(raw string) string {
	const fallback = "/"
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	if !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") || strings.ContainsAny(raw, "\\\r\n") {
		return fallback
	}
	target, err := url.Parse(raw)
	if err != nil || target.IsAbs() || target.Host != "" || target.User != nil {
		return fallback
	}
	if target.Path == "" || strings.HasPrefix(target.Path, "//") || strings.Contains(target.Path, "\\") {
		return fallback
	}
	if target.Path == RoutePrefix+"/login" || target.Path == RoutePrefix+"/setup" || isLegacyWebPagePath(target.Path) {
		return fallback
	}
	return target.String()
}

func loginRedirectTarget(c *gin.Context) string {
	next := safeAuthRedirectTarget(c.Request.URL.RequestURI())
	return RoutePrefix + "/login?next=" + url.QueryEscape(next)
}

func wantsHTML(c *gin.Context) bool {
	if strings.HasPrefix(c.Request.URL.Path, "/api/") || c.GetHeader("X-Requested-With") == "XMLHttpRequest" {
		return false
	}
	accept := c.GetHeader("Accept")
	return accept == "" || strings.Contains(accept, "text/html")
}

func setCurrentUser(c *gin.Context, user *User) {
	if user == nil {
		return
	}
	c.Set(ctxUserID, user.ID)
	c.Set(ctxUserRole, user.normalizedRole())
	c.Set(ctxUsername, user.Username)
}

func currentUserID(c *gin.Context) uint {
	value, exists := c.Get(ctxUserID)
	if !exists {
		return 0
	}
	userID, _ := value.(uint)
	return userID
}

func currentUserRole(c *gin.Context) string {
	value, exists := c.Get(ctxUserRole)
	if !exists {
		return ""
	}
	role, _ := value.(string)
	return role
}

func currentUserIsAdmin(c *gin.Context) bool {
	return currentUserRole(c) == RoleAdmin
}

func authRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		users, err := countUsers()
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "读取账号配置失败"})
			return
		}
		if users == 0 {
			abortForMissingSetup(c)
			return
		}
		user, valid, err := authenticateRequest(c, time.Now())
		if err != nil {
			abortForAuthBackendError(c)
			return
		}
		if valid {
			setCurrentUser(c, user)
			c.Next()
			return
		}
		clearAuthCookie(c)
		if wantsHTML(c) {
			c.Redirect(http.StatusFound, loginRedirectTarget(c))
			c.Abort()
			return
		}
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
	}
}

func abortForMissingSetup(c *gin.Context) {
	if wantsHTML(c) {
		c.Redirect(http.StatusFound, RoutePrefix+"/setup")
		c.Abort()
		return
	}
	c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
		"error": "请先初始化管理员账号", "setupRequired": true,
	})
}

func abortForAuthBackendError(c *gin.Context) {
	if wantsHTML(c) {
		c.String(http.StatusServiceUnavailable, "登录状态校验失败,请稍后重试")
		c.Abort()
		return
	}
	c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "登录状态校验失败,请稍后重试"})
}

func authenticateRequest(c *gin.Context, now time.Time) (*User, bool, error) {
	if cookie, err := c.Cookie(authCookieName); err == nil && cookie != "" {
		secret, err := signingSecret()
		if err != nil {
			return nil, false, err
		}
		if payload, valid := parseSessionValue(secret, cookie, now); valid {
			user, valid, err := authenticatedUserForIdentity(payload.UserID, payload.Username, payload.Epoch)
			if err != nil || valid {
				return user, valid, err
			}
		}
	}
	return authenticatePlaybackTicketRequest(c, now)
}

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

func attachUserOptional() gin.HandlerFunc {
	return func(c *gin.Context) {
		user, valid, err := authenticateRequest(c, time.Now())
		if err != nil {
			log.Printf("[auth] optional identity lookup failed path=%q: %v", c.Request.URL.Path, err)
		} else if valid {
			setCurrentUser(c, user)
		}
		c.Next()
	}
}

func desktopUserMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		user, err := ensureDesktopUser()
		if err != nil || user == nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "初始化本地用户失败"})
			return
		}
		setCurrentUser(c, user)
		c.Next()
	}
}

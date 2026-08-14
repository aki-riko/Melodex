package web

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

const expectedSaveUserHeader = "X-Melodex-Expected-User-ID"

func wantsSaveLocal(c *gin.Context) bool {
	return c != nil && strings.TrimSpace(c.Query("save_local")) == "1"
}

func allowSameOriginWrite(c *gin.Context) bool {
	if c == nil || c.GetHeader("X-Requested-With") != "XMLHttpRequest" {
		return false
	}
	if origin := strings.TrimSpace(c.GetHeader("Origin")); origin != "" {
		normalized, valid := normalizeCORSOrigin(origin)
		return valid && normalized == requestOrigin(c)
	}
	site := strings.ToLower(strings.TrimSpace(c.GetHeader("Sec-Fetch-Site")))
	return site == "" || site == "same-origin" || site == "same-site" || site == "none"
}

func allowSaveLocalRequest(c *gin.Context) bool {
	if !wantsSaveLocal(c) {
		return false
	}
	checks := []func(*gin.Context) bool{
		requireSaveLocalPOST,
		requireSameOriginWrite,
		requireUserForWrite,
		requireExpectedSaveUser,
	}
	for _, check := range checks {
		if !check(c) {
			return false
		}
	}
	return true
}

func requireSaveLocalPOST(c *gin.Context) bool {
	if c.Request.Method == http.MethodPost {
		return true
	}
	c.AbortWithStatusJSON(http.StatusMethodNotAllowed, gin.H{"error": "save_local requires POST"})
	return false
}

func requireSameOriginWrite(c *gin.Context) bool {
	if allowSameOriginWrite(c) {
		return true
	}
	c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "forbidden"})
	return false
}

func requireExpectedSaveUser(c *gin.Context) bool {
	raw := strings.TrimSpace(c.GetHeader(expectedSaveUserHeader))
	if raw == "" {
		return true
	}
	expected, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || expected == 0 {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{
			"error": "invalid expected user", "code": "invalid_expected_user",
		})
		return false
	}
	if uint64(currentUserID(c)) != expected {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{
			"error": "登录账号已变化，批量下载已停止", "code": "user_changed",
		})
		return false
	}
	return true
}

func requireUserForWrite(c *gin.Context) bool {
	if currentUserID(c) > 0 {
		return true
	}
	c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "请先登录后再下载到服务器"})
	return false
}

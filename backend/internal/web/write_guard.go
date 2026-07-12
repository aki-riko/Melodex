package web

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

const expectedSaveUserHeader = "X-Melodex-Expected-User-ID"

func wantsSaveLocal(c *gin.Context) bool {
	return c != nil && strings.TrimSpace(c.Query("save_local")) == "1"
}

func allowSameOriginWrite(c *gin.Context) bool {
	if c == nil {
		return false
	}
	if c.GetHeader("X-Requested-With") != "XMLHttpRequest" {
		return false
	}

	origin := strings.TrimSpace(c.GetHeader("Origin"))
	if origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil {
			return false
		}
		return strings.EqualFold(parsed.Host, c.Request.Host)
	}

	secFetchSite := strings.TrimSpace(strings.ToLower(c.GetHeader("Sec-Fetch-Site")))
	return secFetchSite == "" || secFetchSite == "same-origin" || secFetchSite == "same-site" || secFetchSite == "none"
}

func allowSaveLocalRequest(c *gin.Context) bool {
	if !wantsSaveLocal(c) {
		return false
	}
	if c.Request.Method != http.MethodPost {
		c.AbortWithStatusJSON(http.StatusMethodNotAllowed, gin.H{"error": "save_local requires POST"})
		return false
	}
	if !allowSameOriginWrite(c) {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return false
	}
	// 写共享下载目录必须有已登录用户(以登记归属)。公开下载路由只挂了非阻塞的
	// attachUserOptional,故未登录用户也能到达此 handler——这里强制要求登录,
	// 否则写入的文件无归属、谁都认领不了。桌面模式已注入本地用户,自然通过。
	if !requireUserForWrite(c) {
		return false
	}
	if !requireExpectedSaveUser(c) {
		return false
	}
	return true
}

// requireExpectedSaveUser 将批量任务启动时的用户 ID 与当前已认证会话做一致性比较。
// 该请求头只用于断言，绝不用于选择下载归属；真正的 userID 始终取 gin.Context。
func requireExpectedSaveUser(c *gin.Context) bool {
	raw := strings.TrimSpace(c.GetHeader(expectedSaveUserHeader))
	if raw == "" {
		return true
	}
	expected, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || expected == 0 {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{
			"error": "invalid expected user",
			"code":  "invalid_expected_user",
		})
		return false
	}
	if uint64(currentUserID(c)) != expected {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{
			"error": "登录账号已变化，批量下载已停止",
			"code":  "user_changed",
		})
		return false
	}
	return true
}

// requireUserForWrite 校验当前请求有已登录用户(currentUserID>0),否则 401 并中断。
// 用于写共享资源(save_local 下载)的归属前置校验。
func requireUserForWrite(c *gin.Context) bool {
	if currentUserID(c) == 0 {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "请先登录后再下载到服务器"})
		return false
	}
	return true
}

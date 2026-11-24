package web

import (
	"net/http"
	"strings"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/gin-gonic/gin"
)

var resolveLoginStarter = core.GetQRLoginCreateFunc
var resolveLoginPoller = core.GetQRLoginCheckFunc

func RegisterQRLoginRoutes(api *gin.RouterGroup) {
	api.Handle(http.MethodPost, "/qr_login/:source", startProviderLogin)
	api.Handle(http.MethodGet, "/qr_login/:source", pollProviderLogin)
}

func startProviderLogin(c *gin.Context) {
	start := resolveLoginStarter(providerLoginSource(c))
	if start == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "unsupported qr login source"})
		return
	}
	challenge, err := start()
	if err != nil {
		respondInternalError(c, "发起登录失败, 请稍后重试", err)
		return
	}
	c.JSON(http.StatusOK, challenge)
}

func pollProviderLogin(c *gin.Context) {
	source := providerLoginSource(c)
	key := strings.TrimSpace(c.Query("key"))
	if key == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing qr login key"})
		return
	}
	poll := resolveLoginPoller(source)
	if poll == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "unsupported qr login source"})
		return
	}
	result, err := poll(key)
	if err != nil {
		respondInternalError(c, "登录状态检查失败", err)
		return
	}
	if result != nil && result.Phase == model.LoginSucceeded {
		persistSuccessfulProviderLogin(source, result)
	}
	c.JSON(http.StatusOK, result)
}

func providerLoginSource(c *gin.Context) string {
	return strings.TrimSpace(c.Param("source"))
}

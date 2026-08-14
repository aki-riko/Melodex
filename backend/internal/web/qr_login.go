package web

import (
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/gin-gonic/gin"
)

var (
	resolveLoginStarter = core.GetQRLoginCreateFunc
	resolveLoginPoller  = core.GetQRLoginCheckFunc
	storeProviderCookie = func(provider, cookie string) {
		core.CM.SetAll(map[string]string{provider: cookie})
		core.CM.Save()
	}
)

func RegisterQRLoginRoutes(api *gin.RouterGroup) {
	api.POST("/qr_login/:source", startProviderLogin)
	api.GET("/qr_login/:source", pollProviderLogin)
}

func startProviderLogin(c *gin.Context) {
	provider := strings.TrimSpace(c.Param("source"))
	start := resolveLoginStarter(provider)
	if start == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "unsupported qr login source"})
		return
	}

	challenge, err := start()
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, challenge)
}

func pollProviderLogin(c *gin.Context) {
	provider := strings.TrimSpace(c.Param("source"))
	challengeID := strings.TrimSpace(c.Query("key"))
	if challengeID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing qr login key"})
		return
	}

	poll := resolveLoginPoller(provider)
	if poll == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "unsupported qr login source"})
		return
	}
	result, err := poll(challengeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if result != nil && result.Phase == model.LoginSucceeded {
		persistSuccessfulProviderLogin(provider, result)
	}
	c.JSON(http.StatusOK, result)
}

func persistSuccessfulProviderLogin(provider string, result *model.LoginResult) {
	cookie := loginCookieHeader(result)
	if cookie == "" {
		return
	}
	provider = canonicalCookieProvider(provider)
	result.RawCookie = cookie
	storeProviderCookie(provider, cookie)
	if result.Metadata == nil {
		result.Metadata = make(map[string]string)
	}
	result.Metadata["cookie_saved"] = "true"
	result.Metadata["cookie_source"] = provider
	result.Metadata["cookie_length"] = strconv.Itoa(len(cookie))
}

func loginCookieHeader(result *model.LoginResult) string {
	if result == nil {
		return ""
	}
	if raw := strings.TrimSpace(result.RawCookie); raw != "" {
		return raw
	}
	if len(result.CookieValues) == 0 {
		return ""
	}

	names := make([]string, 0, len(result.CookieValues))
	for name, value := range result.CookieValues {
		if strings.TrimSpace(name) != "" && strings.TrimSpace(value) != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	pairs := make([]string, 0, len(names))
	for _, name := range names {
		pairs = append(pairs, name+"="+strings.TrimSpace(result.CookieValues[name]))
	}
	return strings.Join(pairs, "; ")
}

func canonicalCookieProvider(provider string) string {
	switch strings.TrimSpace(provider) {
	case "qq_wx", "qq_mobile", "qq_connect":
		return "qq"
	default:
		return strings.TrimSpace(provider)
	}
}

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

var resolveLoginStarter = core.GetQRLoginCreateFunc
var resolveLoginPoller = core.GetQRLoginCheckFunc
var storeProviderCookie = func(provider, cookie string) {
	core.CM.SetAll(map[string]string{provider: cookie})
	core.CM.Save()
}

func RegisterQRLoginRoutes(api *gin.RouterGroup) {
	api.POST("/qr_login/:source", startProviderLogin)
	api.GET("/qr_login/:source", pollProviderLogin)
}

func startProviderLogin(c *gin.Context) {
	source := strings.TrimSpace(c.Param("source"))
	createChallenge := resolveLoginStarter(source)
	if createChallenge == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "unsupported qr login source"})
		return
	}
	challenge, err := createChallenge()
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, challenge)
}

func pollProviderLogin(c *gin.Context) {
	source := strings.TrimSpace(c.Param("source"))
	challengeID := strings.TrimSpace(c.Query("key"))
	if challengeID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing qr login key"})
		return
	}
	checkChallenge := resolveLoginPoller(source)
	if checkChallenge == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "unsupported qr login source"})
		return
	}
	result, err := checkChallenge(challengeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if result != nil && result.Phase == model.LoginSucceeded {
		persistSuccessfulProviderLogin(source, result)
	}
	c.JSON(http.StatusOK, result)
}

func persistSuccessfulProviderLogin(source string, result *model.LoginResult) {
	cookie := loginCookieHeader(result)
	if cookie == "" {
		return
	}
	source = canonicalCookieProvider(source)
	result.RawCookie = cookie
	storeProviderCookie(source, cookie)
	if result.Metadata == nil {
		result.Metadata = make(map[string]string)
	}
	result.Metadata["cookie_saved"] = "true"
	result.Metadata["cookie_source"] = source
	result.Metadata["cookie_length"] = strconv.Itoa(len(cookie))
}

func loginCookieHeader(result *model.LoginResult) string {
	if result == nil {
		return ""
	}
	if raw := strings.TrimSpace(result.RawCookie); raw != "" {
		return raw
	}
	names := make([]string, 0, len(result.CookieValues))
	for name, value := range result.CookieValues {
		if strings.TrimSpace(name) != "" && strings.TrimSpace(value) != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	parts := make([]string, 0, len(names))
	for _, name := range names {
		parts = append(parts, name+"="+strings.TrimSpace(result.CookieValues[name]))
	}
	return strings.Join(parts, "; ")
}

func canonicalCookieProvider(source string) string {
	source = strings.TrimSpace(source)
	switch source {
	case "qq_wx", "qq_mobile", "qq_connect":
		return "qq"
	default:
		return source
	}
}

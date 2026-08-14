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

func qrLoginCookieString(result *model.LoginResult) string {
	if result == nil {
		return ""
	}
	if cookie := strings.TrimSpace(result.RawCookie); cookie != "" {
		return cookie
	}
	if len(result.CookieValues) == 0 {
		return ""
	}
	keys := make([]string, 0, len(result.CookieValues))
	for k := range result.CookieValues {
		if strings.TrimSpace(k) == "" {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		v := strings.TrimSpace(result.CookieValues[k])
		if v == "" {
			continue
		}
		parts = append(parts, k+"="+v)
	}
	return strings.Join(parts, "; ")
}

func qrLoginCookieSource(source string) string {
	switch source {
	case "qq_wx", "qq_mobile", "qq_connect":
		return "qq"
	default:
		return source
	}
}

func RegisterQRLoginRoutes(api *gin.RouterGroup) {
	api.POST("/qr_login/:source", func(c *gin.Context) {
		source := strings.TrimSpace(c.Param("source"))
		fn := core.GetQRLoginCreateFunc(source)
		if fn == nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "unsupported qr login source"})
			return
		}
		session, err := fn()
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, session)
	})

	api.GET("/qr_login/:source", func(c *gin.Context) {
		source := strings.TrimSpace(c.Param("source"))
		key := strings.TrimSpace(c.Query("key"))
		if key == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "missing qr login key"})
			return
		}
		fn := core.GetQRLoginCheckFunc(source)
		if fn == nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "unsupported qr login source"})
			return
		}
		result, err := fn(key)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		if result != nil && result.Phase == model.LoginSucceeded {
			cookie := qrLoginCookieString(result)
			if cookie != "" {
				cookieSource := qrLoginCookieSource(source)
				result.RawCookie = cookie
				core.CM.SetAll(map[string]string{cookieSource: cookie})
				core.CM.Save()
				if result.Metadata == nil {
					result.Metadata = make(map[string]string)
				}
				result.Metadata["cookie_saved"] = "true"
				result.Metadata["cookie_source"] = cookieSource
				result.Metadata["cookie_length"] = strconv.Itoa(len(cookie))
			}
		}
		c.JSON(http.StatusOK, result)
	})
}

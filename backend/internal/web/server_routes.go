package web

import (
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/gin-gonic/gin"
)

type StartOptions struct {
	ShouldOpenBrowser bool
	DisableAuth       bool
	ListenHost        string
}

func newWebRouter(options StartOptions) (*gin.Engine, error) {
	router := gin.New()
	router.Use(gin.LoggerWithFormatter(redactedGinLogFormatter), gin.Recovery())
	if err := configureTrustedProxies(router, os.Getenv("MUSIC_DL_TRUSTED_PROXIES")); err != nil {
		return nil, err
	}
	router.Use(corsMiddleware(), securityHeadersMiddleware())

	api := router.Group(RoutePrefix)
	api.GET("/healthz", healthRoute)
	adminAPI, userAPI := bindAuthMiddleware(api, options)
	optionalUserAPI := api.Group("")
	if !options.DisableAuth {
		optionalUserAPI.Use(attachUserOptional())
	}
	for _, route := range legacyStandalonePageRoutes {
		api.GET(route, legacyWebPageGone)
	}
	registerConfigurationRoutes(adminAPI, userAPI, optionalUserAPI)
	registerMediaAndLibraryRoutes(api, adminAPI, userAPI, options)

	RegisterJSONAPIRoutes(router, options)
	RegisterDesktopLyricsRoutes(router, options)
	RegisterSubsonicRoutes(router)
	registerFrontend(router)
	return router, nil
}

func configureTrustedProxies(router *gin.Engine, raw string) error {
	proxies := splitConfiguredList(raw)
	if len(proxies) == 0 {
		return router.SetTrustedProxies(nil)
	}
	if err := router.SetTrustedProxies(proxies); err != nil {
		return errors.New("invalid MUSIC_DL_TRUSTED_PROXIES: " + err.Error())
	}
	return nil
}

func splitConfiguredList(raw string) []string {
	result := make([]string, 0)
	for _, value := range strings.Split(raw, ",") {
		if value = strings.TrimSpace(value); value != "" {
			result = append(result, value)
		}
	}
	return result
}

func healthRoute(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"app": "melodex", "status": "ok"})
}

func bindAuthMiddleware(api *gin.RouterGroup, options StartOptions) (adminAPI, userAPI *gin.RouterGroup) {
	bindAuthRoutes(api)
	if options.DisableAuth {
		api.Use(desktopUserMiddleware())
		return api, api
	}
	adminAPI = api.Group("")
	adminAPI.Use(authRequired(), adminRequired())
	userAPI = api.Group("")
	userAPI.Use(authRequired())
	return adminAPI, userAPI
}

func registerConfigurationRoutes(adminAPI, userAPI, optionalUserAPI *gin.RouterGroup) {
	adminAPI.HEAD("/cookies", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	adminAPI.GET("/cookies", getCookiesRoute)
	adminAPI.POST("/cookies", updateCookiesRoute)
	optionalUserAPI.GET("/settings", getSettingsRoute)
	adminAPI.POST("/settings", updateSettingsRoute)
	userAPI.POST("/user/prefs", updateUserPreferencesRoute)
}

func getCookiesRoute(c *gin.Context) {
	c.JSON(http.StatusOK, core.CM.GetAll())
}

func updateCookiesRoute(c *gin.Context) {
	var cookies map[string]string
	if err := c.ShouldBindJSON(&cookies); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid cookies payload"})
		return
	}
	core.CM.SetAll(cookies)
	core.CM.Save()
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func getSettingsRoute(c *gin.Context) {
	c.JSON(http.StatusOK, effectiveSettingsForUser(currentUserID(c)))
}

func updateSettingsRoute(c *gin.Context) {
	var settings core.WebSettings
	if err := c.ShouldBindJSON(&settings); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid settings payload"})
		return
	}
	if err := core.SaveWebSettings(settings); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, effectiveSettingsForUser(currentUserID(c)))
}

func updateUserPreferencesRoute(c *gin.Context) {
	userID := currentUserID(c)
	if userID == 0 {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
		return
	}
	var preferences UserPref
	if err := c.ShouldBindJSON(&preferences); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid prefs payload"})
		return
	}
	if err := saveUserPref(userID, preferences); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, effectiveSettingsForUser(userID))
}

func registerMediaAndLibraryRoutes(api, adminAPI, userAPI *gin.RouterGroup, options StartOptions) {
	musicAPI := api.Group("")
	if !options.DisableAuth {
		musicAPI.Use(authRequired())
	}
	RegisterMusicRoutes(musicAPI)
	RegisterQRLoginRoutes(adminAPI)
	RegisterCollectionRoutes(userAPI)
	RegisterLocalMusicRoutes(userAPI)
	RegisterSearchHistoryRoutes(userAPI)
	RegisterPlayHistoryRoutes(userAPI)
	RegisterPlaybackDiagnosticRoutes(userAPI)
	RegisterFavoriteRoutes(userAPI)
}

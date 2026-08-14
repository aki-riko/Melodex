package web

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/gin-gonic/gin"
)

const RoutePrefix = "/music"

var (
	legacyMusicPageRoutes = []string{
		"/", "/recommend", "/user_playlists", "/playlist_categories",
		"/category_playlists", "/search", "/playlist", "/album", "/album_jump",
	}
	legacyCollectionPageRoutes = []string{"/my_collections", "/collection"}
	legacyLocalMusicPageRoutes = []string{"/local_music_page"}
	legacyStandalonePageRoutes = []string{"/render"}
)

func isLegacyWebPagePath(requestPath string) bool {
	wanted := strings.TrimSuffix(requestPath, "/")
	if wanted == RoutePrefix {
		return true
	}
	groups := [][]string{
		legacyMusicPageRoutes, legacyCollectionPageRoutes,
		legacyLocalMusicPageRoutes, legacyStandalonePageRoutes,
	}
	for _, group := range groups {
		for _, route := range group {
			if wanted == RoutePrefix+strings.TrimSuffix(route, "/") {
				return true
			}
		}
	}
	return false
}

func defaultSourcesForSearchType(searchType string) []string {
	providers := map[string]func() []string{
		"playlist": core.GetPlaylistSourceNames,
		"album":    core.GetAlbumSourceNames,
		"lyric":    core.GetLyricSearchSourceNames,
	}
	if provider := providers[strings.TrimSpace(searchType)]; provider != nil {
		return provider()
	}
	return core.GetDefaultSourceNames()
}

func corsAllowedOrigins() map[string]bool {
	allowed := make(map[string]bool)
	for _, configured := range strings.Split(os.Getenv("MUSIC_DL_CORS_ORIGINS"), ",") {
		if origin, ok := normalizeCORSOrigin(configured); ok {
			allowed[origin] = true
		}
	}
	return allowed
}

func normalizeCORSOrigin(raw string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", false
	}
	if parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", false
	}
	return strings.ToLower(parsed.Scheme + "://" + parsed.Host), true
}

func requestOrigin(c *gin.Context) string {
	scheme := "http"
	if c.Request.TLS != nil {
		scheme = "https"
	} else if forwarded := strings.TrimSpace(strings.Split(c.GetHeader("X-Forwarded-Proto"), ",")[0]); forwarded == "http" || forwarded == "https" {
		scheme = forwarded
	}
	return strings.ToLower(scheme + "://" + c.Request.Host)
}

func corsMiddleware() gin.HandlerFunc {
	allowed := corsAllowedOrigins()
	return func(c *gin.Context) {
		originHeader := c.GetHeader("Origin")
		if origin, valid := normalizeCORSOrigin(originHeader); valid && (origin == requestOrigin(c) || allowed[origin]) {
			c.Header("Access-Control-Allow-Origin", originHeader)
			c.Header("Vary", "Origin")
			c.Header("Access-Control-Allow-Credentials", "true")
		}
		c.Header("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE")
		c.Header("Access-Control-Allow-Headers", "Origin, X-Requested-With, X-Melodex-Expected-User-ID, Content-Type, Accept, Authorization")
		c.Header("Access-Control-Expose-Headers", "Content-Length, Cache-Control, Content-Language, Content-Type, X-Melodex-Playback-Source, X-Melodex-Chunk-Index, X-Melodex-Chunk-Duration, X-Melodex-Chunk-Final")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

func securityHeadersMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		headers := c.Writer.Header()
		headers.Set("X-Content-Type-Options", "nosniff")
		headers.Set("X-Frame-Options", "SAMEORIGIN")
		headers.Set("Referrer-Policy", "no-referrer")
		c.Next()
	}
}

func setDownloadHeader(c *gin.Context, filename string) {
	filename = cleanDownloadFilename(filename)
	fallback := asciiDownloadFilenameFallback(filename)
	c.Header("Content-Disposition", fmt.Sprintf(
		"attachment; filename=\"%s\"; filename*=UTF-8''%s",
		fallback, url.PathEscape(filename),
	))
}

func cleanDownloadFilename(value string) string {
	value = strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	segments := strings.Split(value, "/")
	filename := strings.TrimSpace(segments[len(segments)-1])
	if filename == "" {
		return "download"
	}
	return filename
}

func asciiDownloadFilenameFallback(filename string) string {
	filename = strings.TrimSpace(filename)
	if filename == "" {
		return "download"
	}
	base, extension := filename, ""
	if dot := strings.LastIndex(filename, "."); dot > 0 && dot < len(filename)-1 {
		candidate := filename[dot:]
		if candidate == asciiDownloadFilenamePart(candidate) {
			base, extension = filename[:dot], candidate
		}
	}
	fallback := strings.Trim(asciiDownloadFilenamePart(base), " .-_")
	if fallback == "" {
		fallback = "download"
	}
	return fallback + extension
}

func asciiDownloadFilenamePart(value string) string {
	var result strings.Builder
	for _, character := range value {
		if character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' ||
			strings.ContainsRune(".-_ ", character) {
			result.WriteRune(character)
		}
	}
	return strings.TrimSpace(result.String())
}

func legacyWebPageGone(c *gin.Context) {
	c.String(http.StatusGone, "该网页界面已下线,请使用 Melodex 前端。")
}

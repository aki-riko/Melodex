package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestLegacyWebRoutesReturnGone(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	api := router.Group(RoutePrefix)
	RegisterMusicRoutes(api)
	RegisterCollectionRoutes(api)
	RegisterLocalMusicRoutes(api)
	for _, route := range legacyStandalonePageRoutes {
		api.GET(route, legacyWebPageGone)
	}

	groups := [][]string{
		legacyMusicPageRoutes,
		legacyCollectionPageRoutes,
		legacyLocalMusicPageRoutes,
		legacyStandalonePageRoutes,
	}
	for _, routes := range groups {
		for _, route := range routes {
			path := RoutePrefix + route
			t.Run(strings.ReplaceAll(path, "/", "_"), func(t *testing.T) {
				req := httptest.NewRequest(http.MethodGet, path, nil)
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, req)

				if rec.Code != http.StatusGone {
					t.Fatalf("GET %s status = %d, want %d", path, rec.Code, http.StatusGone)
				}
			})
		}
	}
}

func TestLocalWebAppURLTargetsSPA(t *testing.T) {
	tests := []struct {
		host string
		want string
	}{
		{host: "", want: "http://localhost:8329/"},
		{host: "0.0.0.0", want: "http://localhost:8329/"},
		{host: "127.0.0.1", want: "http://127.0.0.1:8329/"},
		{host: "::1", want: "http://[::1]:8329/"},
	}

	for _, test := range tests {
		if got := localWebAppURL(test.host, "8329"); got != test.want {
			t.Fatalf("localWebAppURL(%q) = %q, want %q", test.host, got, test.want)
		}
	}
}

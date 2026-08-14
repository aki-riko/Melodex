package web

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCORSSameHostRequiresSameScheme(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(corsMiddleware())
	router.GET("/test", func(c *gin.Context) { c.Status(http.StatusOK) })

	request := httptest.NewRequest(http.MethodGet, "http://music.example/test", nil)
	request.Header.Set("Origin", "https://music.example")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if origin := recorder.Header().Get("Access-Control-Allow-Origin"); origin != "" {
		t.Fatalf("cross-scheme request allowed origin=%q", origin)
	}

	request = httptest.NewRequest(http.MethodGet, "http://music.example/test", nil)
	request.Header.Set("Origin", "https://music.example")
	request.Header.Set("X-Forwarded-Proto", "https")
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if origin := recorder.Header().Get("Access-Control-Allow-Origin"); origin != "https://music.example" {
		t.Fatalf("proxied HTTPS same-origin=%q, want https://music.example", origin)
	}
}

func TestTrustedProxyConfigurationIsFailClosed(t *testing.T) {
	gin.SetMode(gin.TestMode)
	if err := configureTrustedProxies(gin.New(), "not-a-cidr"); err == nil {
		t.Fatal("invalid trusted proxy configuration was accepted")
	}

	router := gin.New()
	if err := configureTrustedProxies(router, ""); err != nil {
		t.Fatal(err)
	}
	router.GET("/ip", func(c *gin.Context) { c.String(http.StatusOK, c.ClientIP()) })
	request := httptest.NewRequest(http.MethodGet, "http://music.example/ip", nil)
	request.RemoteAddr = "203.0.113.10:4321"
	request.Header.Set("X-Forwarded-For", "198.51.100.8")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Body.String() != "203.0.113.10" {
		t.Fatalf("untrusted X-Forwarded-For changed ClientIP to %q", recorder.Body.String())
	}
}

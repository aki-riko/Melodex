package web

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestPlaybackTicketValidationIsBoundToOneStreamQuery(t *testing.T) {
	setupUserTestDB(t)
	resetAuthRuntimeForTest()
	t.Cleanup(resetAuthRuntimeForTest)
	t.Setenv(playbackTicketMaxAgeEnv, "30m")
	user, err := createUser("desktop-owner", "ownerpass1", RoleUser)
	if err != nil {
		t.Fatalf("createUser: %v", err)
	}
	now := time.Unix(1_700_000_000, 0)
	canonical, err := canonicalPlaybackQuery(
		"source=netease&id=2140404278&name=%E6%B5%B7%E6%A3%A0&stream=1",
	)
	if err != nil {
		t.Fatalf("canonicalPlaybackQuery: %v", err)
	}
	ticket, err := createPlaybackTicket(user, canonical, now)
	if err != nil {
		t.Fatalf("createPlaybackTicket: %v", err)
	}
	secret, err := signingSecret()
	if err != nil {
		t.Fatalf("signingSecret: %v", err)
	}

	payload, ok := parsePlaybackTicketValue(secret, ticket, canonical, now.Add(time.Minute))
	if !ok || payload.UserID != user.ID {
		t.Fatalf("fresh ticket payload = %+v, ok=%v", payload, ok)
	}
	if _, ok := parsePlaybackTicketValue(
		secret, ticket, strings.Replace(canonical, "2140404278", "other-song", 1), now.Add(time.Minute),
	); ok {
		t.Fatal("ticket must reject a changed song id")
	}
	if _, ok := parsePlaybackTicketValue(secret, ticket+"x", canonical, now.Add(time.Minute)); ok {
		t.Fatal("ticket must reject a changed signature")
	}
	if _, ok := parsePlaybackTicketValue(secret, ticket, canonical, now.Add(30*time.Minute+time.Second)); ok {
		t.Fatal("ticket must expire at the configured maximum age")
	}
}

func TestCanonicalPlaybackQueryRejectsWriteAndAmbiguousParameters(t *testing.T) {
	for name, raw := range map[string]string{
		"missing stream":  "id=track&source=qq",
		"write operation": "id=track&source=qq&stream=1&save_local=1",
		"duplicate id":    "id=track&id=other&source=qq&stream=1",
		"embedded ticket": "id=track&source=qq&stream=1&playback_token=stale",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := canonicalPlaybackQuery(raw); err == nil {
				t.Fatalf("canonicalPlaybackQuery(%q) should fail", raw)
			}
		})
	}
}

func TestPlaybackTicketMaxAgeConfigurationIsSessionBound(t *testing.T) {
	t.Setenv(sessionDaysEnv, "")
	t.Setenv(sessionMaxAgeEnv, "")
	t.Setenv(playbackTicketMaxAgeEnv, "")
	if got := playbackTicketMaxAge(); got != defaultPlaybackTicketMaxAge {
		t.Fatalf("default playback ticket max age=%s", got)
	}

	t.Setenv(playbackTicketMaxAgeEnv, "30m")
	if got := playbackTicketMaxAge(); got != 30*time.Minute {
		t.Fatalf("configured playback ticket max age=%s", got)
	}

	t.Setenv(sessionMaxAgeEnv, "2h")
	t.Setenv(playbackTicketMaxAgeEnv, "12h")
	if got := playbackTicketMaxAge(); got != 2*time.Hour {
		t.Fatalf("session-capped playback ticket max age=%s", got)
	}
}

func TestPlaybackTicketEndpointEnablesCookieFreeNativeStream(t *testing.T) {
	setupUserTestDB(t)
	resetAuthRuntimeForTest()
	t.Cleanup(resetAuthRuntimeForTest)
	gin.SetMode(gin.TestMode)
	user, err := createUser("native-player", "ownerpass1", RoleUser)
	if err != nil {
		t.Fatalf("createUser: %v", err)
	}
	session, err := createUserSession(user, time.Now())
	if err != nil {
		t.Fatalf("createUserSession: %v", err)
	}

	router := gin.New()
	secureAPI := router.Group("/api/v1")
	secureAPI.Use(authRequired())
	secureAPI.POST("/playback_ticket", jsonPlaybackTicketHandler)
	secureMusic := router.Group(RoutePrefix)
	secureMusic.Use(authRequired())
	secureMusic.GET("/download", func(c *gin.Context) {
		c.String(http.StatusOK, "%d:%s", currentUserID(c), c.Query("id"))
	})

	query := "id=2140404278&source=netease&name=%E6%B5%B7%E6%A3%A0%E5%8F%88%E8%90%BD%E5%BE%AE%E9%9B%A8%E6%97%B6&stream=1"
	body, err := json.Marshal(playbackTicketRequest{Query: query})
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	issueRequest := httptest.NewRequest(
		http.MethodPost, "/api/v1/playback_ticket", bytes.NewReader(body),
	)
	issueRequest.Header.Set("Content-Type", "application/json")
	issueRequest.AddCookie(&http.Cookie{Name: authCookieName, Value: session})
	issueResponse := httptest.NewRecorder()
	router.ServeHTTP(issueResponse, issueRequest)
	if issueResponse.Code != http.StatusOK {
		t.Fatalf("issue status=%d body=%s", issueResponse.Code, issueResponse.Body.String())
	}
	if got := issueResponse.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control=%q", got)
	}
	var issued struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(issueResponse.Body.Bytes(), &issued); err != nil {
		t.Fatalf("decode issued URL: %v", err)
	}
	parsed, err := url.Parse(issued.URL)
	if err != nil || parsed.Path != RoutePrefix+"/download" {
		t.Fatalf("issued URL=%q err=%v", issued.URL, err)
	}
	if parsed.Query().Get(playbackTicketQueryName) == "" {
		t.Fatal("issued URL is missing playback token")
	}

	streamRequest := httptest.NewRequest(http.MethodGet, issued.URL, nil)
	streamRequest.Header.Set("Accept", "application/octet-stream")
	streamResponse := httptest.NewRecorder()
	router.ServeHTTP(streamResponse, streamRequest)
	if streamResponse.Code != http.StatusOK {
		t.Fatalf("ticket stream status=%d body=%s", streamResponse.Code, streamResponse.Body.String())
	}
	if want := "1:2140404278"; streamResponse.Body.String() != want {
		t.Fatalf("ticket stream body=%q want=%q", streamResponse.Body.String(), want)
	}

	tampered := *parsed
	tamperedValues := tampered.Query()
	tamperedValues.Set("id", "other-song")
	tampered.RawQuery = tamperedValues.Encode()
	tamperedRequest := httptest.NewRequest(http.MethodGet, tampered.String(), nil)
	tamperedRequest.Header.Set("Accept", "application/octet-stream")
	tamperedResponse := httptest.NewRecorder()
	router.ServeHTTP(tamperedResponse, tamperedRequest)
	if tamperedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("tampered stream status=%d want=401", tamperedResponse.Code)
	}

	if err := setUserPassword(user.ID, "newpass99"); err != nil {
		t.Fatalf("setUserPassword: %v", err)
	}
	revokedRequest := httptest.NewRequest(http.MethodGet, issued.URL, nil)
	revokedRequest.Header.Set("Accept", "application/octet-stream")
	revokedResponse := httptest.NewRecorder()
	router.ServeHTTP(revokedResponse, revokedRequest)
	if revokedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("revoked stream status=%d want=401", revokedResponse.Code)
	}
}

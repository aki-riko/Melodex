package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func newPlaybackDiagnosticTestRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	group := r.Group("/music")
	group.Use(func(c *gin.Context) {
		c.Set(ctxUserID, uint(7))
		c.Next()
	})
	RegisterPlaybackDiagnosticRoutes(group)
	return r
}

func TestPlaybackDiagnosticAcceptsKnownSameOriginEvent(t *testing.T) {
	r := newPlaybackDiagnosticTestRouter()
	req := httptest.NewRequest(http.MethodPost, "/music/playback_diagnostics", strings.NewReader(`{
		"event":"ended_transition","source":"qq","song_id":"song-1","next_song_id":"song-2","play_seq":"9"
	}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestPlaybackDiagnosticAcceptsLifecycleObservationEvent(t *testing.T) {
	r := newPlaybackDiagnosticTestRouter()
	req := httptest.NewRequest(http.MethodPost, "/music/playback_diagnostics", strings.NewReader(`{
		"event":"playing","page_id":"page-1","bundle":"index-test.js",
		"audio_slot":"primary","active_audio_slot":"primary",
		"standby_audio_slot":"","media_session_state":"playing"
	}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
}

func TestPlaybackDiagnosticRejectsMissingXHRHeader(t *testing.T) {
	r := newPlaybackDiagnosticTestRouter()
	req := httptest.NewRequest(http.MethodPost, "/music/playback_diagnostics", strings.NewReader(`{"event":"ended_ignored"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusForbidden, rec.Body.String())
	}
}

func TestPlaybackDiagnosticRejectsUnknownEvent(t *testing.T) {
	r := newPlaybackDiagnosticTestRouter()
	req := httptest.NewRequest(http.MethodPost, "/music/playback_diagnostics", strings.NewReader(`{"event":"progress"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

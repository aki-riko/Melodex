package web

import (
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

const playbackDiagnosticMaxBytes = 8 * 1024

var allowedPlaybackDiagnosticEvents = map[string]struct{}{
	"autoplay_rejected":          {},
	"background_pause_recovered": {},
	"background_pause_recovery":  {},
	"background_pause_rejected":  {},
	"ended_ignored":              {},
	"ended_transition":           {},
	"pause":                      {},
	"prefetch_consumed":          {},
	"prefetch_failed":            {},
	"prefetch_ready":             {},
	"queue_exhausted":            {},
	"stalled":                    {},
	"suspend":                    {},
	"waiting":                    {},
}

type playbackDiagnosticRequest struct {
	Event        string  `json:"event"`
	Source       string  `json:"source"`
	SongID       string  `json:"song_id"`
	NextSource   string  `json:"next_source"`
	NextSongID   string  `json:"next_song_id"`
	PlaySeq      string  `json:"play_seq"`
	SourceKind   string  `json:"source_kind"`
	Visibility   string  `json:"visibility"`
	Reason       string  `json:"reason"`
	Mode         string  `json:"mode"`
	QueueLength  int     `json:"queue_length"`
	CurrentTime  float64 `json:"current_time"`
	Duration     float64 `json:"duration"`
	BufferedEnd  float64 `json:"buffered_end"`
	Paused       bool    `json:"paused"`
	Ended        bool    `json:"ended"`
	ReadyState   int     `json:"ready_state"`
	NetworkState int     `json:"network_state"`
}

func cleanPlaybackDiagnosticText(value string, max int) string {
	value = strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ").Replace(value))
	if len(value) > max {
		return value[:max]
	}
	return value
}

func RegisterPlaybackDiagnosticRoutes(api *gin.RouterGroup) {
	api.POST("/playback_diagnostics", func(c *gin.Context) {
		if !allowSameOriginWrite(c) {
			c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, playbackDiagnosticMaxBytes)

		var req playbackDiagnosticRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid diagnostic payload"})
			return
		}
		req.Event = cleanPlaybackDiagnosticText(req.Event, 40)
		if _, ok := allowedPlaybackDiagnosticEvents[req.Event]; !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid diagnostic event"})
			return
		}

		log.Printf(
			"player-diagnostic user_id=%d event=%s source=%s song_id=%s next_source=%s next_song_id=%s seq=%s source_kind=%s visibility=%s reason=%s mode=%s queue=%d time=%.1f/%.1f buffered_end=%.1f paused=%t ended=%t ready=%d network=%d",
			currentUserID(c),
			req.Event,
			cleanPlaybackDiagnosticText(req.Source, 32),
			cleanPlaybackDiagnosticText(req.SongID, 160),
			cleanPlaybackDiagnosticText(req.NextSource, 32),
			cleanPlaybackDiagnosticText(req.NextSongID, 160),
			cleanPlaybackDiagnosticText(req.PlaySeq, 32),
			cleanPlaybackDiagnosticText(req.SourceKind, 24),
			cleanPlaybackDiagnosticText(req.Visibility, 24),
			cleanPlaybackDiagnosticText(req.Reason, 160),
			cleanPlaybackDiagnosticText(req.Mode, 24),
			req.QueueLength,
			req.CurrentTime,
			req.Duration,
			req.BufferedEnd,
			req.Paused,
			req.Ended,
			req.ReadyState,
			req.NetworkState,
		)
		c.Status(http.StatusNoContent)
	})
}

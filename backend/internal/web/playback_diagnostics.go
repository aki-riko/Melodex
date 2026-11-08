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
	"device_info":                {},
	"ended_ignored":              {},
	"ended_transition":           {},
	"media_session_action":       {},
	"mse_buffer_cleanup_failed":  {},
	"mse_chunk_ready":            {},
	"mse_chunk_retry":            {},
	"mse_end_of_stream_failed":   {},
	"mse_pipeline_error":         {},
	"mse_play_resolved":          {},
	"mse_queue_exhausted":        {},
	"mse_segment_ready":          {},
	"mse_start_failed":           {},
	"mse_track_active":           {},
	"mse_track_transition":       {},
	"pause":                      {},
	"page_loaded":                {},
	"play_resolved":              {},
	"playing":                    {},
	"prefetch_consumed":          {},
	"prefetch_failed":            {},
	"prefetch_ready":             {},
	"queue_exhausted":            {},
	"stalled":                    {},
	"suspend":                    {},
	"waiting":                    {},
	// 原生 seek 取证(2026-11 排查「手机拖动进度条无效」)。
	//
	// 为什么要专门两个事件:上一轮排查把「服务端收到的 Range 偏移」当成了
	// 「用户拖到的位置」,于是 570053 被换算成 5.7 秒,推出了"seek 差 20 倍"的
	// 错误方向。实际上 570053 是 FLAC 元数据区结束、第一个音频帧的偏移,
	// 它等价于「从 0 秒开始」。所以真正缺的不是"差多少倍",而是
	// 「JS 请求了多少毫秒 / ExoPlayer 认不认这首歌能 seek / 它报的时长是多少」。
	// 这三件事只有原生侧知道,必须由 Kotlin 回填后经此通道落到服务端日志。
	"seek_requested": {},
	"seek_settled":   {},
}

type playbackDiagnosticRequest struct {
	Event               string  `json:"event"`
	Source              string  `json:"source"`
	SongID              string  `json:"song_id"`
	NextSource          string  `json:"next_source"`
	NextSongID          string  `json:"next_song_id"`
	PlaySeq             string  `json:"play_seq"`
	SourceKind          string  `json:"source_kind"`
	Visibility          string  `json:"visibility"`
	Reason              string  `json:"reason"`
	Mode                string  `json:"mode"`
	QueueLength         int     `json:"queue_length"`
	CurrentTime         float64 `json:"current_time"`
	Duration            float64 `json:"duration"`
	BufferedEnd         float64 `json:"buffered_end"`
	Paused              bool    `json:"paused"`
	Ended               bool    `json:"ended"`
	ReadyState          int     `json:"ready_state"`
	NetworkState        int     `json:"network_state"`
	PageID              string  `json:"page_id"`
	Bundle              string  `json:"bundle"`
	AudioSlot           string  `json:"audio_slot"`
	ActiveSlot          string  `json:"active_audio_slot"`
	StandbySlot         string  `json:"standby_audio_slot"`
	MediaState          string  `json:"media_session_state"`
	WasDiscarded        bool    `json:"was_discarded"`
	ActivationSupported bool    `json:"user_activation_supported"`
	ActivationActive    bool    `json:"user_activation_active"`
	ActivationEver      bool    `json:"user_activation_has_been_active"`
	PageElapsedMS       float64 `json:"page_elapsed_ms"`
	DeviceInfo          string  `json:"device_info"`
	// ---- 原生 seek 取证字段(2026-11) ----
	// 只允许原生侧回填,均为数字/短文本,不承接任意大对象。
	// 单位统一为毫秒,与 ExoPlayer 的 API 一致,避免前端/原生来回换算出错。
	SeekRequestedMs int64  `json:"seek_requested_ms"` // JS 传下来的目标位置
	SeekAppliedMs   int64  `json:"seek_applied_ms"`   // 原生 seek 之后 player.currentPosition
	SeekDurationMs  int64  `json:"seek_duration_ms"`  // 此刻 player.duration(TIME_UNSET 折 0)
	SeekPositionMs  int64  `json:"seek_position_ms"`  // seek 之前的 currentPosition
	Seekable        string `json:"seekable"`          // "true"/"false"/"" 未知;false 时 seekTo 会退化
	MediaItemType   string `json:"media_item_type"`   // "audio/flac"/"audio/mp4a|mp4a.40.2"...判断容器格式
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
			"player-diagnostic user_id=%d event=%s page_id=%s bundle=%s audio_slot=%s active_slot=%s standby_slot=%s media_state=%s discarded=%t activation_supported=%t activation_active=%t activation_ever=%t page_elapsed_ms=%.0f device=%s source=%s song_id=%s next_source=%s next_song_id=%s seq=%s source_kind=%s visibility=%s reason=%s mode=%s queue=%d time=%.1f/%.1f buffered_end=%.1f paused=%t ended=%t ready=%d network=%d seek_req_ms=%d seek_applied_ms=%d seek_dur_ms=%d seek_pos_ms=%d seekable=%s item_type=%s ua=%s",
			currentUserID(c),
			req.Event,
			cleanPlaybackDiagnosticText(req.PageID, 80),
			cleanPlaybackDiagnosticText(req.Bundle, 120),
			cleanPlaybackDiagnosticText(req.AudioSlot, 24),
			cleanPlaybackDiagnosticText(req.ActiveSlot, 24),
			cleanPlaybackDiagnosticText(req.StandbySlot, 24),
			cleanPlaybackDiagnosticText(req.MediaState, 24),
			req.WasDiscarded,
			req.ActivationSupported,
			req.ActivationActive,
			req.ActivationEver,
			req.PageElapsedMS,
			cleanPlaybackDiagnosticText(req.DeviceInfo, 160),
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
			req.SeekRequestedMs,
			req.SeekAppliedMs,
			req.SeekDurationMs,
			req.SeekPositionMs,
			cleanPlaybackDiagnosticText(req.Seekable, 8),
			cleanPlaybackDiagnosticText(req.MediaItemType, 24),
			cleanPlaybackDiagnosticText(c.Request.UserAgent(), 180),
		)
		c.Status(http.StatusNoContent)
	})
}

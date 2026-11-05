package web

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/gin-gonic/gin"
)

// 用注入的失败任务提供者跑真实 handler 路径。
//
// 之前这个测试直接调 writePlaybackChunkFailure, 确实能过 —— 但也因此**抓不住
// 真正的回退**: 把 handler 里那句改回 c.String(502, "Failed to prepare playback
// chunk") 时测试照样绿。事故的成因恰恰是"helper 正确、接线忘了", 所以必须让
// 测试走 handler 本身。
func withFailingChunkProvider(t *testing.T, err error) {
	t.Helper()
	original := playbackChunkJobProvider
	playbackChunkJobProvider = func(*gin.Context, *model.Track, int) (*playbackChunkJob, error) {
		return nil, err
	}
	t.Cleanup(func() { playbackChunkJobProvider = original })
}

func runChunkHandler(t *testing.T, err error) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	withFailingChunkProvider(t, err)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/music/playback_segment?chunk=0", nil)
	playbackChunkHandler(ctx, &model.Track{ID: "000cdiQg0r5FsI", Source: "qq"}, "0")
	return recorder
}

// 分块播放失败必须给出中文原因 + "值不值得重试"。
//
// 事故(2026-11-06 用户截图): 播放条显示
//
//	「差一步的爱情(最痛的不是失去)」播放失败：Failed to prepare playback chunk；请点一下播放重试。
//
// 两个问题同时存在:
//  1. 英文内部错误被原样贴给用户(应该给人看的中文原因);
//  2. 建议"点一下播放重试", 但生产日志里的真实原因是
//     provider has no downloadable url for this song —— 重试永远不会成功。
//
// 根因: Web/MSE 连续播放走的是 playbackChunkHandler(分块分支), 而 2026-10 那次
// 「说清真实原因」的修复只接到了非分块的 playbackSegmentHandler 上, 分块分支
// 还留着旧的一句英文 502, 也没有 X-Melodex-Playback-Retryable 头。
//
// 这个测试锁住: 分块失败必须与整段失败用同一套分类口径。
func TestPlaybackChunkFailureSpeaksUserLanguage(t *testing.T) {
	gin.SetMode(gin.TestMode)

	cases := []struct {
		name          string
		err           error
		wantRetryable string
		// 响应体必须含中文原因, 而且绝不能是内部英文错误
		wantContain    string
		wantNotContain []string
	}{
		{
			name:          "付费曲/已下架(生产真实原因, 不可重试)",
			err:           core.ErrProviderPaidOnly,
			wantRetryable: "0",
			wantContain:   "下架",
			wantNotContain: []string{
				"Failed to prepare playback chunk",
				"Failed to generate playback chunk",
				"provider has no downloadable url",
			},
		},
		{
			name:          "上游限流(可重试)",
			err:           core.ErrProviderRateLimited,
			wantRetryable: "1",
			wantContain:   "限流",
			wantNotContain: []string{
				"Failed to prepare playback chunk",
			},
		},
		{
			name:          "无法解析出地址(不可重试)",
			err:           errors.New("provider returned an invalid download URL"),
			wantRetryable: "0",
			wantContain:   "没有返回可播放地址",
			wantNotContain: []string{
				"Failed to prepare playback chunk",
			},
		},
		{
			name:          "网络/临时故障(可重试)",
			err:           errors.New("dial tcp 10.0.0.1:443: connect: connection refused"),
			wantRetryable: "1",
			wantContain:   "暂时不可用",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			recorder := runChunkHandler(t, tc.err)

			if recorder.Code != http.StatusBadGateway {
				t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadGateway)
			}
			if got := recorder.Header().Get("X-Melodex-Playback-Retryable"); got != tc.wantRetryable {
				t.Fatalf("X-Melodex-Playback-Retryable = %q, want %q —— 前端靠它决定要不要建议重试",
					got, tc.wantRetryable)
			}
			body := recorder.Body.String()
			if !strings.Contains(body, tc.wantContain) {
				t.Fatalf("响应体 = %q, 应含中文原因 %q", body, tc.wantContain)
			}
			for _, forbidden := range tc.wantNotContain {
				if strings.Contains(body, forbidden) {
					t.Fatalf("响应体 = %q, 不得包含内部英文错误 %q(会被原样贴到播放条上)",
						body, forbidden)
				}
			}
		})
	}
}

// 回归: 分块路径与非分块路径必须用同一套分类, 不能各说各话。
// 这条单独写, 因为事故的成因正是"两条路径只修了一条"。
func TestPlaybackChunkAndSegmentAgreeOnClassification(t *testing.T) {
	for _, err := range []error{
		core.ErrProviderPaidOnly,
		core.ErrProviderRateLimited,
		errors.New("provider returned no matching song identity"),
		errors.New("context deadline exceeded"),
	} {
		wantReason, wantRetryable := classifyPlaybackOpenError(err)

		recorder := runChunkHandler(t, err)

		if recorder.Body.String() != wantReason {
			t.Fatalf("分块路径原因 %q 与整段路径原因 %q 不一致(同一错误不该两种说法)",
				recorder.Body.String(), wantReason)
		}
		if got := recorder.Header().Get("X-Melodex-Playback-Retryable"); got != boolFlag(wantRetryable) {
			t.Fatalf("分块路径 retryable=%q 与分类结果 %q 不一致", got, boolFlag(wantRetryable))
		}
	}
}

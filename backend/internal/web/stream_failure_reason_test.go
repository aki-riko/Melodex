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

// 回归(2026-11-22 真实事故):酷我付费曲 fpay=1 时,kuwo_source 对**付费曲连取址请求
// 都不发**(省一次往返,且防止把 11 秒试听片段当整曲交付),于是 Go 侧 resolve 返回空。
//
// 旧实现只回一句 "Failed to get URL" + 404 —— 前端(<audio> 拿不到响应头,只能看到
// 播放失败)拿不到任何原因,于是笼统提示"当前源无法播放,正在自动换源"。用户既不知道
// 是"需要会员",也不知道换源是不是正解。
//
// 现在这条路径必须把 classifyPlaybackOpenError 的结论带给前端,与 MSE 分块链路使用
// 同一套 X-Melodex-Playback-Retryable / X-Melodex-Playback-Reason 约定。
func runStreamUnavailable(t *testing.T, track *model.Track, err error) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/music/download?stream=1", nil)
	serveStreamUnavailable(ctx, track, err)
	return recorder
}

func TestStreamUnavailableCarriesReasonForPaidTrack(t *testing.T) {
	recorder := runStreamUnavailable(t,
		&model.Track{ID: "671442807", Source: "kuwo", Name: "遗症", Artist: "格林Colin", Duration: 198},
		core.ErrProviderPaidOnly,
	)

	result := recorder.Result()
	if result.StatusCode != http.StatusNotFound {
		t.Fatalf("取不到地址应回 404(既有行为不能变), got %d", result.StatusCode)
	}
	if got := result.Header.Get("X-Melodex-Playback-Retryable"); got != "0" {
		t.Fatalf("X-Melodex-Playback-Retryable = %q, 付费/下架类必须为 0(不可重试)", got)
	}
	reason := result.Header.Get("X-Melodex-Playback-Reason")
	if reason == "" {
		t.Fatal("必须带 X-Melodex-Playback-Reason —— 前端要直接展示它")
	}
	// 与分块链路同一份文案口径:必须让用户知道这是会员/下架类,不是网络抖动。
	if !strings.Contains(reason, "会员") && !strings.Contains(reason, "下架") {
		t.Fatalf("reason = %q, 必须说清是会员/下架类原因, 否则用户不知道该做什么", reason)
	}
}

// 限流类错误必须标成可重试:等一会儿确实能播, 不能误导用户去换歌。
func TestStreamUnavailableRateLimitedIsRetryable(t *testing.T) {
	recorder := runStreamUnavailable(t,
		&model.Track{ID: "537854140", Source: "netease", Name: "后遗症", Duration: 250},
		core.ErrProviderRateLimited,
	)

	result := recorder.Result()
	if result.StatusCode != http.StatusNotFound {
		t.Fatalf("got %d, want 404", result.StatusCode)
	}
	if got := result.Header.Get("X-Melodex-Playback-Retryable"); got != "1" {
		t.Fatalf("X-Melodex-Playback-Retryable = %q, 限流必须为 1(可重试)", got)
	}
	if reason := result.Header.Get("X-Melodex-Playback-Reason"); reason == "" {
		t.Fatal("限流也要带原因, 前端据此提示稍等重试")
	}
}

// resolve 返回空字符串但 err==nil 时也必须走同一条分类路径(不能因没有 error 就跳过)。
func TestStreamUnavailableEmptyURLWithoutErrorStillCarriesReason(t *testing.T) {
	recorder := runStreamUnavailable(t,
		&model.Track{ID: "1", Source: "kuwo", Name: "x"},
		nil,
	)

	result := recorder.Result()
	if result.StatusCode != http.StatusNotFound {
		t.Fatalf("空地址应回 404, got %d", result.StatusCode)
	}
	if result.Header.Get("X-Melodex-Playback-Reason") == "" {
		t.Fatal("空地址也要带原因头, 否则前端无从判断")
	}
}

// 网络类(可重试)与付费类(不可重试)必须给出相反的 retryable,
// 这是这次事故里最容易搞反、后果最直接的一点。
func TestStreamUnavailableRetryableOpposesPaid(t *testing.T) {
	network := runStreamUnavailable(t, &model.Track{ID: "2", Source: "qq", Name: "y"},
		errors.New("dial tcp: connection refused"))
	if got := network.Result().Header.Get("X-Melodex-Playback-Retryable"); got != "1" {
		t.Fatalf("网络类错误 retryable = %q, 应为 1(可重试)", got)
	}

	paid := runStreamUnavailable(t, &model.Track{ID: "3", Source: "qq", Name: "z"}, core.ErrProviderPaidOnly)
	if got := paid.Result().Header.Get("X-Melodex-Playback-Retryable"); got != "0" {
		t.Fatalf("付费类错误 retryable = %q, 应为 0(不可重试)", got)
	}
}

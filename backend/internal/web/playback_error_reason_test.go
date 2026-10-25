package web

import (
	"errors"
	"strings"
	"testing"

	"github.com/aki-riko/Melodex/backend/core"
)

// 播放失败原因分类的契约测试。
//
// 这段逻辑修正过一次错误归因,所以测试要同时锁住"正确的结论"和"曾经犯过的错":
//
// 事故复盘(2026-10):「天龙八部之宿敌」播到第 17 个分块后 502。
// 我曾判定为"原唱已下架",但实测证明该曲在搜索结果第 1 条就是
// (mid=001bLkWD2EYA4P),被丢弃的真因是 QQ 付费曲
// (pay_down=1, pay_month=1, price_track=200) 取不到 purl。
// 同期还存在 QQ code=2001 限流(7 小时 46 次),它会让搜索返回空,
// 那种情况**等一会儿重试是有效的**。
//
// 因此最关键的一条断言是:限流必须 retryable=true,
// 付费曲必须 retryable=false —— 两者搞反都会给出错误引导。
func TestClassifyPlaybackOpenError(t *testing.T) {
	cases := []struct {
		name          string
		err           error
		wantRetryable bool
		wantContain   string
		wantNotContain string
	}{
		{
			name:          "哨兵:上游限流(应可重试)",
			err:           core.ErrProviderRateLimited,
			wantRetryable: true,
			wantContain:   "限流",
			wantNotContain: "换一个源",
		},
		{
			name:          "哨兵:付费曲拿不到地址(不可重试,应引导换源)",
			err:           core.ErrProviderPaidOnly,
			wantRetryable: false,
			wantContain:   "付费或会员",
			wantNotContain: "限流",
		},
		{
			name:          "文案兜底:code=2001 限流",
			err:           errors.New("provider returned no matching songs"),
			wantRetryable: true,
			wantContain:   "限流",
			wantNotContain: "已不可用",
		},
		{
			name:          "文案兜底:候选里没有该 id(付费/版权)",
			err:           errors.New("open source: get download url: provider returned no matching song identity"),
			wantRetryable: false,
			wantContain:   "付费或会员",
		},
		{
			name:          "缺少查找数据",
			err:           errors.New("missing provider lookup data"),
			wantRetryable: false,
			wantContain:   "缺少播放所需",
		},
		{
			name:          "不可播(版权受限)",
			err:           errors.New("provider returned an invalid download URL"),
			wantRetryable: false,
			wantContain:   "没有返回可播放地址",
		},
		{
			name:          "网络超时(应可重试)",
			err:           errors.New("context deadline exceeded"),
			wantRetryable: true,
			wantContain:   "暂时不可用",
		},
		{
			name:          "连接被拒(应可重试)",
			err:           errors.New("dial tcp 127.0.0.1:8840: connect: connection refused"),
			wantRetryable: true,
			wantContain:   "暂时不可用",
		},
		{
			name:          "nil 错误也要有兜底文案",
			err:           nil,
			wantRetryable: true,
			wantContain:   "播放失败",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reason, retryable := classifyPlaybackOpenError(tc.err)
			if retryable != tc.wantRetryable {
				t.Fatalf("retryable = %v, want %v (reason=%q)", retryable, tc.wantRetryable, reason)
			}
			if !strings.Contains(reason, tc.wantContain) {
				t.Fatalf("reason = %q, want it to contain %q", reason, tc.wantContain)
			}
			if tc.wantNotContain != "" && strings.Contains(reason, tc.wantNotContain) {
				t.Fatalf("reason = %q, 不应包含 %q（会给出错误引导）", reason, tc.wantNotContain)
			}
			if reason == "" {
				t.Fatal("reason 不能为空 —— 前端会直接展示它")
			}
		})
	}
}

// 核心回归:限流与付费曲的 retryable 必须相反。
// 这条单独写,因为它是这次事故里最容易搞反、后果最直接的一点。
func TestRateLimitedAndPaidOnlyAreOpposite(t *testing.T) {
	_, rateLimitedRetryable := classifyPlaybackOpenError(core.ErrProviderRateLimited)
	_, paidOnlyRetryable := classifyPlaybackOpenError(core.ErrProviderPaidOnly)
	if !rateLimitedRetryable {
		t.Fatal("限流必须是可重试 —— 等一会儿确实能播, 不许告诉用户换歌")
	}
	if paidOnlyRetryable {
		t.Fatal("付费曲必须不可重试 —— 反复点播放永远不会成功")
	}
	if rateLimitedRetryable == paidOnlyRetryable {
		t.Fatal("两者必须相反, 否则提示会误导用户")
	}
}

func TestClassifyPlaybackOpenErrorIsCaseInsensitive(t *testing.T) {
	upper := errors.New("PROVIDER RETURNED NO MATCHING SONG IDENTITY")
	reason, retryable := classifyPlaybackOpenError(upper)
	if retryable {
		t.Fatalf("大写的同类错误也必须判成不可重试, got reason=%q", reason)
	}
}

// 回归:生产日志里出现过的真实错误串都要被正确分类。
// 证据来自 2026-10-25 生产日志:
//   [playback-chunk] 创建任务失败 source="qq" id="001bLkWD2EYA4P" chunk=17:
//     open source: get download url: provider returned no matching song identity
//   ... provider returned no matching songs
func TestClassifyPlaybackOpenErrorRealLogStrings(t *testing.T) {
	// 有候选但没目标 id → 付费/版权 → 不可重试
	paid := "open source: get download url: provider returned no matching song identity"
	if reason, retryable := classifyPlaybackOpenError(errors.New(paid)); retryable {
		t.Fatalf("identity 类错误应判不可重试, got %q", reason)
	}

	// 无候选 → 可能是限流 → 应可重试(不能一口咬定下架)
	noSongs := "open source: get download url: provider returned no matching songs"
	reason, retryable := classifyPlaybackOpenError(errors.New(noSongs))
	if !retryable {
		t.Fatalf("0 候选应判可重试(可能是 2001 限流), got %q", reason)
	}
	if strings.Contains(reason, "已不可用") {
		t.Fatalf("0 候选不得说成'已不可用'(实测 46 次 2001 限流就是这样), got %q", reason)
	}
}

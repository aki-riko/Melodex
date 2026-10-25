package web

import (
	"errors"
	"strings"
	"testing"
)

// 播放失败原因分类的契约测试。
//
// 需求背景:「天龙八部之宿敌」QQ 原唱下架后,用户看到的是
// "没能取到音频数据,请点一下播放重试" —— 但重试永远不会好,
// 因为问题在上游曲库。反过来,真正的网络抖动应该明确引导重试。
// 所以这条分类的核心是:**把"重试有用"和"重试没用"分开**。
func TestClassifyPlaybackOpenError(t *testing.T) {
	cases := []struct {
		name          string
		err           error
		wantRetryable bool
		wantContain   string
	}{
		{
			name:          "上游查不到这首歌(下架)",
			err:           errors.New("open source: get download url: provider returned no matching song identity"),
			wantRetryable: false,
			wantContain:   "已不可用",
		},
		{
			name:          "上游搜索返回 0 条",
			err:           errors.New("provider returned no matching songs"),
			wantRetryable: false,
			wantContain:   "已不可用",
		},
		{
			name:          "缺少查找数据",
			err:           errors.New("missing provider lookup data"),
			wantRetryable: false,
			wantContain:   "已不可用",
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
			if reason == "" {
				t.Fatal("reason 不能为空 —— 前端会直接展示它")
			}
		})
	}
}

// 关键区分:大小写不敏感(provider 的错误文案大小写不总是统一)。
func TestClassifyPlaybackOpenErrorIsCaseInsensitive(t *testing.T) {
	upper := errors.New("PROVIDER RETURNED NO MATCHING SONG IDENTITY")
	_, retryable := classifyPlaybackOpenError(upper)
	if retryable {
		t.Fatal("大写的同类错误也必须判成不可重试")
	}
}

// 回归:真实日志里出现过的两种文案都要被识别。
// 证据来自 2026-10-25 生产日志:
//   [playback-chunk] 创建任务失败 source="qq" id="001bLkWD2EYA4P" chunk=17:
//     open source: get download url: provider returned no matching song identity
//   ... provider returned no matching songs
func TestClassifyPlaybackOpenErrorRealLogStrings(t *testing.T) {
	realOnes := []string{
		"open source: get download url: provider returned no matching song identity",
		"open source: get download url: provider returned no matching songs",
	}
	for _, raw := range realOnes {
		reason, retryable := classifyPlaybackOpenError(errors.New(raw))
		if retryable {
			t.Fatalf("真实日志错误 %q 应判成不可重试, got retryable=true (%s)", raw, reason)
		}
	}
}

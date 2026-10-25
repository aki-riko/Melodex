package web

import (
	"strings"

	"github.com/aki-riko/Melodex/backend/core"
)

// 播放失败原因分类:决定"该等"还是"该换"。
//
// 背景(2026-10 真实事故, 两次修正后的最终结论):
// 「天龙八部之宿敌」播到第 17 个分块后 502。我最初归因为"原唱已下架",但实测证明
// 那首歌在搜索结果里**第 1 条就是**(mid=001bLkWD2EYA4P),它被丢弃的真实原因是:
//   pay: {pay_down:1, pay_month:1, pay_play:1, price_track:200}
// 即 QQ 付费曲 —— 取址时上游不发 purl, 于是 provider 把 20 首里的 16 首丢弃,
// Go 侧拿到的 4 首里没有目标 mid, 就报了 no matching song identity。
//
// 同一时期还存在第二个独立问题: QQ 的 code=2001 **限流**(provider 代码注释明确写着
// "QQ 用 2001 表示这次搜索被限流"),7 小时内出现 46 次。限流也会让搜索返回空,
// 这种情况**等一会儿重试是有效的**,绝不能提示用户"已下架、换一首"。
//
// 所以三类必须分开:
//   1. 限流        → retryable=true, 提示稍等重试
//   2. 付费/无地址 → retryable=false, 提示需要会员/换源
//   3. 其他(网络) → retryable=true
func classifyPlaybackOpenError(err error) (reason string, retryable bool) {
	if err == nil {
		return "播放失败", true
	}

	// 优先用哨兵错误判断(不依赖错误文案, 最可靠)。
	if core.IsProviderRateLimited(err) {
		return "音乐源正在限流", true
	}
	if core.IsProviderPaidOnly(err) {
		return "这首歌在当前音乐源需要付费或会员才能播放", false
	}

	message := strings.ToLower(err.Error())

	switch {
	// 旧文案兜底(侧边车未提供 empty_reason 时仍可能走到这里)
	case strings.Contains(message, "no matching song identity"):
		// 候选里没有目标 id: 说明这首拿不到地址(付费/版权), 而不是网络问题
		return "这首歌在当前音乐源需要付费或会员才能播放", false
	case strings.Contains(message, "no matching songs"):
		// 有个候选都没有: 可能是限流, 也可能是真没货 —— 给可重试的选项更安全,
		// 因为对"真没货"重试只是白点一次, 而对"限流"不许重试才是真误导。
		return "音乐源暂时没返回结果（可能被限流）", true
	case strings.Contains(message, "missing provider lookup data"):
		return "这首歌缺少播放所需的信息", false
	case strings.Contains(message, "invalid download url"),
		strings.Contains(message, "is_invalid"),
		strings.Contains(message, "provider returned an invalid"):
		return "当前音乐源没有返回可播放地址（可能是付费曲或版权受限）", false
	}

	// 其余视为可重试:上游超时、连接被拒、sidecar 临时不可用等。
	return "音频源暂时不可用", true
}

func boolFlag(v bool) string {
	if v {
		return "1"
	}
	return "0"
}

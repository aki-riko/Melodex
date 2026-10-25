package web

import (
	"strings"
)

// 播放失败原因分类:区分"重试可能有用"和"重试一定没用"。
//
// 为什么需要(2026-10 真实案例):「天龙八部之宿敌」QQ 原唱下架后,旧 songmid 在
// 重新搜索时查不到,Go 侧按"歌名+歌手"相似度兜底,结果只剩翻唱/DJ版,
// 相似度不足 → provider returned no matching song identity。
// 前端拿到的却是一律的"没能取到音频数据,请点一下播放重试" ——
// 用户会反复点播放,而问题在上游曲库,永远不会好。
//
// 反过来,真正的网络抖动/超时应该明确引导重试。所以这里把两类分开:
//   - 曲库/身份类错误:retryable=false,提示"该曲在源上已不可用,建议换源或换一首"
//   - 其他(超时/网络/ffmpeg 临时失败):retryable=true,提示可重试
func classifyPlaybackOpenError(err error) (reason string, retryable bool) {
	if err == nil {
		return "播放失败", true
	}
	message := strings.ToLower(err.Error())

	// 上游曲库身份不匹配:重试无意义。
	// 这两句来自 core/provider_bridge.go 的 resolveProviderSong。
	switch {
	case strings.Contains(message, "no matching song identity"),
		strings.Contains(message, "no matching songs"),
		strings.Contains(message, "missing provider lookup data"):
		return "这首歌在当前音乐源上已不可用(可能已下架),换一个源或换一首试试", false
	case strings.Contains(message, "invalid download url"),
		strings.Contains(message, "is_invalid"),
		strings.Contains(message, "provider returned an invalid"):
		return "当前音乐源没有返回可播放地址(版权受限或已下架),换一首试试", false
	}

	// 其余视为可重试:上游超时、连接被拒、sidecar 临时不可用等。
	return "音频源暂时不可用,请稍后重试", true
}

func boolFlag(v bool) string {
	if v {
		return "1"
	}
	return "0"
}

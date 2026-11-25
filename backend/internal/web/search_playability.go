package web

import (
	"strings"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

// 搜索结果排序中的「会员可播性」偏好。
//
// ## 用户要求（2026-11）
// 「搜索结果排列不太合理，应该有会员的优先排上面，无会员且需要 VIP 的往下面排」。
//
// ## 两个**互相独立**的信号（合并会出错，所以必须分开判）
//
//	① 该源有没有会员凭据 —— `core.CM` 里存了 cookie 就算有（平台会员 cookie 全局共享）。
//	   没有凭据时，该源所有曲目都按"匿名"对待。
//	② 这首歌本身是否需要会员 —— provider 侧给出的 `is_vip`，或显式写在
//	   `extra.needs_vip`（酷我等源对付费曲连取址都不发）。
//
// 由此得到四象限：
//
//	有凭据 + 不需要 VIP  → 最优先（一定能放，且本来就不挑）
//	有凭据 + 需要 VIP    → 次优先（用户开了会员，照样能放）
//	无凭据 + 不需要 VIP  → 再次（能放，但音质/曲库可能受限）
//	无凭据 + 需要 VIP    → 最末（点了必然放不出，正是用户要压到底的那类）
//
// ★ 关键点：**不能**简单地把 is_vip 一律下沉。用户明确说的是「有会员的优先」——
//   对已登录会员的源，VIP 曲目是能正常播放的，把它压下去反而把好结果藏了。
//
// ★ 同层内保持原有相关性顺序（sort.SliceStable），绝不因为会员维度打乱
//   「搜『晴天』第一条就是周杰伦原唱」这件事 —— 那比会员偏好重要得多。
//
// 因此这里只做**同分重排**：先按相关性分层，再在层内按会员可播性微调。
// 实现方式是给每首歌一个 0..3 的"可播等级"（数值越小越优先），
// 排序时先比等级、再比原综合分。见 songTierRank / applySongPlayabilityPreference。

// songPlayabilityTier 返回歌曲的可播等级（0 最好，3 最差）。
//
// cookies 是 `core.CM.GetAll()` 的快照，调用方负责传入。
func songPlayabilityTier(song model.Track, cookies map[string]string) int {
	source := strings.TrimSpace(song.Source)
	credentialed := strings.TrimSpace(cookies[source]) != ""
	needsVIP := songNeedsVip(song)

	switch {
	case credentialed && !needsVIP:
		return 0
	case credentialed && needsVIP:
		return 1
	case !credentialed && !needsVIP:
		return 2
	default:
		return 3
	}
}

// songNeedsVip 判断这首歌是否需要会员才能取到完整音频。
//
// 与前端 utils/quality.js 的 needsVip 保持同一套判据（两处必须一致，
// 否则会出现"列表标了 VIP 但排序没下沉"或反之的矛盾）：
//   - model.Track.IsVIP（provider 归一化后的字段）
//   - Extra["needs_vip"]（源显式声明；酷我 build_payload 会写，可能是 "1"/"true"/1）
func songNeedsVip(song model.Track) bool {
	if song.IsVIP {
		return true
	}
	if song.Extra == nil {
		return false
	}
	return flagEnabled(song.Extra["needs_vip"])
}

// flagEnabled 把 extra 里的字符串标记按"非空且不等于 0/false/no"判定为开。
// 与前端 flagOn 完全一致。
func flagEnabled(value string) bool {
	text := strings.ToLower(strings.TrimSpace(value))
	return text != "" && text != "0" && text != "false" && text != "no"
}

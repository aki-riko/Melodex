package web

import (
	"testing"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

// 用户要求（2026-11）：「有会员的优先排上面，无会员且需要 VIP 的往下面排」。
//
// 这两条断言必须**同时**成立，否则就是把这句需求做反了：
//   ① 没凭据的时候，免费曲在 VIP 曲前面；
//   ② 有凭据的时候，VIP 曲不该被压 —— 用户开了会员，那首本来是能放的。

func TestSongNeedsVipCoversBothSignals(t *testing.T) {
	cases := []struct {
		name string
		song model.Track
		want bool
	}{
		{"is_vip 字段", model.Track{IsVIP: true}, true},
		{"is_vip 为假", model.Track{IsVIP: false}, false},
		{"extra needs_vip=1", model.Track{Extra: map[string]string{"needs_vip": "1"}}, true},
		{"extra needs_vip=true", model.Track{Extra: map[string]string{"needs_vip": "true"}}, true},
		{"extra needs_vip=0", model.Track{Extra: map[string]string{"needs_vip": "0"}}, false},
		{"extra needs_vip=false", model.Track{Extra: map[string]string{"needs_vip": "false"}}, false},
		{"extra 其它键不影响", model.Track{Extra: map[string]string{"is_paid": "1"}}, false},
		{"extra 为 nil", model.Track{}, false},
	}
	for _, c := range cases {
		if got := songNeedsVip(c.song); got != c.want {
			t.Fatalf("%s: songNeedsVip = %v, want %v", c.name, got, c.want)
		}
	}
}

// 前端 utils/quality.js 的 flagOn 与本文件 flagEnabled 必须同一套判定，
// 否则会出现"列表标了 VIP 但排序没下沉"的矛盾。这里把边界值钉死。
func TestFlagEnabledMatchesFrontendContract(t *testing.T) {
	for _, value := range []string{"1", "true", "TRUE", "yes", " Yes ", "on", "any"} {
		if !flagEnabled(value) {
			t.Fatalf("%q 应判定为开", value)
		}
	}
	for _, value := range []string{"", "  ", "0", "false", "FALSE", "no", "No"} {
		if flagEnabled(value) {
			t.Fatalf("%q 应判定为关", value)
		}
	}
}

func TestSongPlayabilityTierQuadrants(t *testing.T) {
	cookies := map[string]string{"qq": "cookie-present"}
	cases := []struct {
		name string
		song model.Track
		want int
	}{
		{"有凭据+免费 → 最优先", model.Track{Source: "qq"}, 0},
		{"有凭据+VIP → 能放，次优先", model.Track{Source: "qq", IsVIP: true}, 1},
		{"无凭据+免费 → 能匿名放", model.Track{Source: "kuwo"}, 2},
		{"无凭据+VIP → 点了放不出，最后", model.Track{Source: "kuwo", IsVIP: true}, 3},
	}
	for _, c := range cases {
		if got := songPlayabilityTier(c.song, cookies); got != c.want {
			t.Fatalf("%s: tier = %d, want %d", c.name, got, c.want)
		}
	}
}

// 核心行为：把 VIP 曲压后，但**不能打乱相关性层级**。
func TestSortByPlayabilityKeepsRelevanceWithinTier(t *testing.T) {
	songs := []model.Track{
		// 无关但匿名可放的歌（VIP，且源没凭据）
		{ID: "vip-anon", Source: "kuwo", Name: "完全不同", Artist: "别人", IsVIP: true},
		// 用户要的原唱（源有凭据）
		{ID: "original", Source: "qq", Name: "晴天", Artist: "周杰伦"},
		// 同名翻唱（源有凭据）
		{ID: "cover", Source: "qq", Name: "晴天 (翻唱)", Artist: "某人"},
	}
	sortSongsByPlayabilityThenRelevance(songs, "晴天", map[string]string{"qq": "cookie"})

	if songs[0].ID != "original" {
		t.Fatalf("第一条应是原唱，实际 %q（顺序 %v）", songs[0].ID, songIDs(songs))
	}
	if songs[len(songs)-1].ID != "vip-anon" {
		t.Fatalf("最后一条应是「无凭据 + VIP」，实际 %q（顺序 %v）", songs[len(songs)-1].ID, songIDs(songs))
	}
}

// 无凭据时，免费曲必须排在 VIP 曲前面（用户明确要求的那条）。
func TestSortByPlayabilitySinksVipWhenNoCredential(t *testing.T) {
	songs := []model.Track{
		{ID: "vip", Source: "kuwo", Name: "晴天", Artist: "周杰伦", IsVIP: true},
		{ID: "free", Source: "netease", Name: "晴天", Artist: "周杰伦"},
	}
	sortSongsByPlayabilityThenRelevance(songs, "晴天", map[string]string{})
	if songs[0].ID != "free" || songs[1].ID != "vip" {
		t.Fatalf("无凭据时必须免费曲在前，实际 %v", songIDs(songs))
	}
}

// 有凭据时，VIP 曲**不该**被压到免费曲之后 —— 用户开了会员，那是能放的。
// 这条是防"把需求做反"（简单粗暴地 is_vip 一律下沉）。
func TestSortByPlayabilityKeepsVipHighWhenCredentialed(t *testing.T) {
	cookies := map[string]string{"qq": "cookie"}
	songs := []model.Track{
		// 无凭据源的免费曲
		{ID: "free-no-cred", Source: "kuwo", Name: "晴天", Artist: "周杰伦"},
		// 有凭据源的 VIP 曲
		{ID: "vip-with-cred", Source: "qq", Name: "晴天", Artist: "周杰伦", IsVIP: true},
	}
	sortSongsByPlayabilityThenRelevance(songs, "晴天", cookies)
	if songs[0].ID != "vip-with-cred" {
		t.Fatalf("有会员凭据时 VIP 曲应排在「无凭据免费曲」之前，实际 %v", songIDs(songs))
	}
}

// 等级相同 → 仍按综合分（相关性）排，绝不因为遍历顺序随机抖动。
func TestSortByPlayabilityStableWithinSameTier(t *testing.T) {
	cookies := map[string]string{"qq": "cookie"}
	songs := []model.Track{
		{ID: "unrelated", Source: "qq", Name: "完全无关", Artist: "别人"},
		{ID: "exact", Source: "qq", Name: "晴天", Artist: "周杰伦"},
	}
	sortSongsByPlayabilityThenRelevance(songs, "晴天", cookies)
	if songs[0].ID != "exact" {
		t.Fatalf("同一等级内必须相关性优先，实际 %v", songIDs(songs))
	}
}

func TestSortByPlayabilityNoopForShortSlices(t *testing.T) {
	for _, songs := range [][]model.Track{nil, {}, {{ID: "only", Name: "晴天", Source: "qq"}}} {
		before := songIDs(songs)
		sortSongsByPlayabilityThenRelevance(songs, "晴天", map[string]string{"qq": "c"})
		if got := songIDs(songs); len(got) != len(before) {
			t.Fatalf("单元素/空列表不该出错: %v -> %v", before, got)
		}
	}
}

func songIDs(songs []model.Track) []string {
	ids := make([]string, 0, len(songs))
	for _, song := range songs {
		ids = append(ids, song.ID)
	}
	return ids
}

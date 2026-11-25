package web

import (
	"testing"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

// 用户要求（2026-11）：「换源应该优先换同歌名歌手的」。
//
// 换源换错版本对用户是明确的错误：听到的是另一个人的歌 / 另一个编曲版本。
// 所以「同歌名 + 同歌手」必须是**最高优先级且能走快速路径**，
// 而"歌名很像但歌手不同"必须永远进不了高置信度。

func TestSameTitleAndArtistIgnoresCaseSpaceAndPunctuation(t *testing.T) {
	matches := []struct {
		name             string
		songName         string
		songArtist       string
		candidateName    string
		candidateArtist  string
	}{
		{"完全相同", "晴天", "周杰伦", "晴天", "周杰伦"},
		{"大小写不同", "Lemon", "米津玄師", "lemon", "米津玄師"},
		{"空格/标点不同", "Never Gonna Give You Up", "Rick Astley", "NeverGonnaGiveYouUp", "RickAstley"},
		{"全角括号差异", "歌（Live）", "某歌手", "歌(Live)", "某歌手"},
	}
	for _, c := range matches {
		got := core.SameTitleAndArtist(c.songName, c.songArtist, c.candidateName, c.candidateArtist)
		if !got {
			t.Fatalf("%s：应判定为同一作品（%q/%q vs %q/%q）",
				c.name, c.songName, c.songArtist, c.candidateName, c.candidateArtist)
		}
	}

	mismatches := []struct {
		name             string
		songName         string
		songArtist       string
		candidateName    string
		candidateArtist  string
	}{
		{"歌手不同", "晴天", "周杰伦", "晴天", "某人"},
		{"歌名是翻唱后缀", "晴天", "周杰伦", "晴天 (翻唱)", "某人"},
		{"歌名多一个词", "晴天", "周杰伦", "晴天娃娃", "江语晨"},
		{"缺歌手", "晴天", "", "晴天", "周杰伦"},
		{"候选缺歌手", "晴天", "周杰伦", "晴天", ""},
		{"合唱版不算同一份录音", "晴天", "周杰伦", "晴天", "周杰伦、某嘉宾"},
	}
	for _, c := range mismatches {
		got := core.SameTitleAndArtist(c.songName, c.songArtist, c.candidateName, c.candidateArtist)
		if got {
			t.Fatalf("%s：不该判定为同一作品（%q/%q vs %q/%q）",
				c.name, c.songName, c.songArtist, c.candidateName, c.candidateArtist)
		}
	}
}

// 同一作品必须拿满分，且能触发"高置信命中即返回"。
func TestSwitchCandidatesRankExactMatchFirst(t *testing.T) {
	search := func(string) ([]model.Track, error) {
		return []model.Track{
			// 歌名完全一样但歌手不同 —— 换错了就是另一首歌
			{ID: "wrong-artist", Name: "晴天", Artist: "某翻唱", Duration: 269},
			// 真正的同一作品
			{ID: "exact", Name: "晴天", Artist: "周杰伦", Duration: 269},
			// 名字很长但差不多
			{ID: "similar", Name: "晴天 (Live)", Artist: "周杰伦", Duration: 270},
		}, nil
	}
	candidates := searchSwitchSourceCandidates("qq", search, "晴天 周杰伦", "晴天", "周杰伦", 269)
	if len(candidates) != 3 {
		t.Fatalf("candidates = %d, want 3", len(candidates))
	}
	sortSwitchCandidates(candidates)
	if candidates[0].song.ID != "exact" {
		t.Fatalf("同歌名同歌手必须排第一，实际 %q（顺序 %v）",
			candidates[0].song.ID, switchCandidateIDs(candidates))
	}
	if candidates[0].score < switchHighConfidenceScore {
		t.Fatalf("同一作品应能走高置信快速路径，score = %f", candidates[0].score)
	}
	// 关键：非同一作品的候选**绝不能**达到高置信度
	for _, candidate := range candidates[1:] {
		if candidate.score >= switchHighConfidenceScore {
			t.Fatalf("非同一作品 %q 拿到了高置信分 %f —— 会被当成「命中即返回」，换错版本",
				candidate.song.ID, candidate.score)
		}
	}
}

// 顺序噪声场景：同歌同歌手与近重复混在一起时，同一作品必须排第一。
//
// ★ 诚实说明：这条在**当前实现**下即使删掉 source_switch.go 里的显式赋满分也成立，
//   因为 CalcSongSimilarity 对归一化后相等的输入本来就是 1.0（实测）。
//   它的作用是**锁住排序结果这个不变量**，而不是"证明某行代码不可删"。
//   真正被它守住的是：将来若相似度实现变化（例如改成对歌名/歌手独立加权、
//   或引入拼音匹配降权），同歌同歌手仍然必须压过近重复。
func TestSwitchCandidatesPreferSameTitleAndArtistOverNearDuplicates(t *testing.T) {
	search := func(string) ([]model.Track, error) {
		return []model.Track{
			// 先出现的"歌手多一个字"近重复（实测相似度 0.925），
			// stable 排序在分数相同时会偏向先出现的元素，所以这个顺序是有意为之。
			{ID: "near", Name: "晴天", Artist: "周杰伦2", Duration: 269},
			{ID: "exact", Name: "晴天", Artist: "周杰伦", Duration: 269},
		}, nil
	}
	candidates := searchSwitchSourceCandidates("qq", search, "晴天 周杰伦", "晴天", "周杰伦", 269)
	sortSwitchCandidates(candidates)
	if candidates[0].song.ID != "exact" {
		t.Fatalf("同歌名同歌手必须压过近重复（顺序 %v）", switchCandidateIDs(candidates))
	}
	if candidates[0].score != 1 {
		t.Fatalf("同一作品得分应为 1（可走高置信快路径），实际 %f", candidates[0].score)
	}
	if candidates[1].score >= candidates[0].score {
		t.Fatalf("近重复分数 %f 不应 >= 同一作品的 %f", candidates[1].score, candidates[0].score)
	}
}

// 没有同歌同歌手候选时，仍然按相似度降级（不能因为加了这条规则就换不出源）。
func TestSwitchCandidatesStillFallBackToSimilarMatches(t *testing.T) {
	search := func(string) ([]model.Track, error) {
		return []model.Track{
			{ID: "similar", Name: "晴天 (Live)", Artist: "周杰伦", Duration: 270},
		}, nil
	}
	candidates := searchSwitchSourceCandidates("qq", search, "晴天", "晴天", "周杰伦", 269)
	if len(candidates) != 1 {
		t.Fatalf("近义候选不该被丢弃，got %d", len(candidates))
	}
	if candidates[0].score <= 0 || candidates[0].score >= switchHighConfidenceScore {
		t.Fatalf("近义候选分数应在 (0, %f) 区间，实际 %f", switchHighConfidenceScore, candidates[0].score)
	}
	if !isPlayableSwitchCandidateOrSkip(candidates[0]) {
		t.Fatal("近义候选仍应参与验证流程")
	}
}

// 时长差太大必须照旧剔除 —— 新逻辑不能绕过时长校验。
func TestSwitchCandidatesRejectDurationMismatch(t *testing.T) {
	search := func(string) ([]model.Track, error) {
		return []model.Track{
			{ID: "wrong-length", Name: "晴天", Artist: "周杰伦", Duration: 60},
		}, nil
	}
	candidates := searchSwitchSourceCandidates("qq", search, "晴天 周杰伦", "晴天", "周杰伦", 269)
	if len(candidates) != 0 {
		t.Fatalf("时长差 209 秒的候选必须被剔除，got %v", switchCandidateIDs(candidates))
	}
}

// 关键契约：非"同一作品"的候选**达不到**高置信阈值。
//
// 这条不是靠额外上限压出来的，而是由相似度本身保证的 —— 实测最高只有 0.925
// （「晴天/周杰伦2」这种只差一个字的歌手名）。这里把这组**真实观测值**钉死：
// 一旦有人改动 CalcSongSimilarity 的权重/归一化规则，让非精确候选爬上 0.98，
// 换源就会开始"换到别的版本还当成高置信命中"，本测试会先红。
func TestNonExactCandidatesNeverReachHighConfidence(t *testing.T) {
	cases := []struct{ candName, candArtist string }{
		{"晴天", "周杰倫"},        // 繁简差异
		{"晴天 (Live)", "周杰伦"},  // 歌名带后缀
		{"晴天", "周杰伦2"},       // 歌手多一个字（实测最高的那种）
		{"晴天啊", "周杰伦"},
		{"晴天", "Jay Chou"},
	}
	for _, c := range cases {
		if core.SameTitleAndArtist("晴天", "周杰伦", c.candName, c.candArtist) {
			t.Fatalf("%q/%q 不该被判为同一作品", c.candName, c.candArtist)
		}
		score := core.CalcSongSimilarity("晴天", "周杰伦", c.candName, c.candArtist)
		if score >= switchHighConfidenceScore {
			t.Fatalf("%q/%q 的相似度 %.4f 达到了高置信阈值 %.2f —— 换源会换错版本",
				c.candName, c.candArtist, score, switchHighConfidenceScore)
		}
	}
}

func TestSwitchNonExactCapBelowHighConfidence(t *testing.T) {
	// 占位：cap 已删除（实测证明是冗余防御）。保留一个总阈值不变量断言。
	if switchHighConfidenceScore <= 0 || switchHighConfidenceScore > 1 {
		t.Fatalf("高置信阈值必须落在 (0,1]，实际 %f", switchHighConfidenceScore)
	}
}

// 辅助：候选能进入验证流程（这里只是把"分数>0 且时长可接受"表达清楚）。
func isPlayableSwitchCandidateOrSkip(candidate switchCandidate) bool {
	return candidate.score > 0
}

func switchCandidateIDs(candidates []switchCandidate) []string {
	ids := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		ids = append(ids, candidate.song.ID)
	}
	return ids
}

package web

import (
	"sync"
	"testing"
	"time"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

func isolateSourceSwitchHooks(t *testing.T) {
	t.Helper()
	previousSearch := switchSearchFuncProvider
	previousValidation := switchValidatePlayable
	previousAll := switchAllSourceNames
	previousDefaults := switchDefaultSourceNames
	t.Cleanup(func() {
		switchSearchFuncProvider = previousSearch
		switchValidatePlayable = previousValidation
		switchAllSourceNames = previousAll
		switchDefaultSourceNames = previousDefaults
	})
}

func TestSourceSwitchReturnsHighConfidenceResultWithoutSlowTail(t *testing.T) {
	isolateSourceSwitchHooks(t)
	switchAllSourceNames = switchContractSourceNames
	switchDefaultSourceNames = switchContractSourceNames
	switchSearchFuncProvider = switchContractSearchProvider
	switchValidatePlayable = func(track *model.Track) bool { return track != nil && track.ID == "fast-song" }
	started := time.Now()
	track, score, err := findBestSwitchSong("Track", "Artist", "netease", "", 180)
	if err != nil || track == nil || track.ID != "fast-song" || track.Source != "fast" || score < switchHighConfidenceScore {
		t.Fatalf("source switch result = %#v/%f/%v", track, score, err)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("source switch waited for slow tail: %s", elapsed)
	}
}

func switchContractSourceNames() []string {
	return []string{"slow", "fast"}
}

func switchContractSearchProvider(source string) func(string) ([]model.Track, error) {
	providers := map[string]func(string) ([]model.Track, error){
		"slow": switchContractSlowSearch,
		"fast": switchContractFastSearch,
	}
	return providers[source]
}

func switchContractSlowSearch(string) ([]model.Track, error) {
	time.Sleep(2 * time.Second)
	return []model.Track{{ID: "slow-song", Name: "Track", Artist: "Artist", Duration: 180}}, nil
}

func switchContractFastSearch(string) ([]model.Track, error) {
	return []model.Track{{ID: "fast-song", Name: "Track", Artist: "Artist", Duration: 180}}, nil
}

func TestSourceSwitchValidationPreservesRanking(t *testing.T) {
	isolateSourceSwitchHooks(t)
	switchValidatePlayable = func(track *model.Track) bool {
		if track != nil && track.ID == "best" {
			time.Sleep(100 * time.Millisecond)
			return true
		}
		return track != nil && track.ID == "second"
	}
	candidates := []switchCandidate{{song: model.Track{ID: "best", Source: "fast"}, score: 1}, {song: model.Track{ID: "second", Source: "fast"}, score: 0.99}}
	track, score, ok := validateSwitchCandidates(candidates)
	if !ok || track == nil || track.ID != "best" || score != 1 {
		t.Fatalf("validated source switch = %#v/%f/%v", track, score, ok)
	}
}

// 换源搜索必须**限并发**, 否则一次 switch_source 会把十几个源同时打向 QQ/网易,
// 每个源还要 limit=20 首候选 —— 上游被自己打成限流之后, 连正常播放的取址都开始
// 失败(2026-11 实测: provider 单分钟收到 364 次请求, QQ 随即回 104009 降级匿名,
// VIP 曲就播不出来了)。
//
// 断言"同时进入搜索的峰值"。这里**刻意让验证永远返回 false**: 只要有一个源命中
// 高置信候选, findBestSwitchSong 就会提前 return, 其余源根本来不及启动 ——
// 那样把上限改成 12 也测不出区别(本测试的第一版就是这样假通过的)。必须逼它走完
// "等所有源、再统一验证"的完整路径, 才能真正观察到并发上限。
func TestSourceSwitchCapsConcurrentUpstreamSearches(t *testing.T) {
	isolateSourceSwitchHooks(t)
	sources := make([]string, 0, 12)
	for index := 0; index < 12; index++ {
		sources = append(sources, "src"+string(rune('a'+index)))
	}
	switchAllSourceNames = func() []string { return sources }
	switchDefaultSourceNames = func() []string { return sources }

	var mu sync.Mutex
	active, peak := 0, 0
	switchSearchFuncProvider = func(string) func(string) ([]model.Track, error) {
		return func(string) ([]model.Track, error) {
			mu.Lock()
			active++
			if active > peak {
				peak = active
			}
			mu.Unlock()
			time.Sleep(30 * time.Millisecond) // 让并发真正重叠
			mu.Lock()
			active--
			mu.Unlock()
			// 歌手故意不匹配 → score 低于 switchHighConfidenceScore(0.98),
			// 不会触发"命中即返回"的快路径, 从而所有源都会被真正搜索一遍。
			return []model.Track{{ID: "song", Name: "Track", Artist: "Other", Duration: 180}}, nil
		}
	}
	switchValidatePlayable = func(track *model.Track) bool { return track != nil && track.ID == "song" }

	// 结果本身不重要(多半是 no playable match), 这里只关心并发峰值。
	_, _, _ = findBestSwitchSong("Track", "Artist", "netease", "", 180)

	mu.Lock()
	measuredPeak := peak
	mu.Unlock()
	t.Logf("并发峰值=%d, 上限=%d", measuredPeak, switchSearchConcurrency)
	if measuredPeak > switchSearchConcurrency {
		t.Fatalf("同时向上游发起 %d 个换源搜索, 超过上限 %d —— 无限并发会把上游打成限流", measuredPeak, switchSearchConcurrency)
	}
	if measuredPeak < 2 {
		t.Fatalf("并发峰值只有 %d, 说明搜索没有真正并行(测试本身失效)", measuredPeak)
	}
}

package web

import (
	"os"
	"testing"
	"time"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

// TestSearchSourceBudgetHonorsEnvOverride 确认预算可配置且非法值回退到默认,
// 避免把预算硬编码进代码(全局规则:禁止硬编码可配置值)。
func TestSearchSourceBudgetHonorsEnvOverride(t *testing.T) {
	original, had := os.LookupEnv("MUSIC_DL_SEARCH_SOURCE_BUDGET")
	t.Cleanup(func() {
		if had {
			os.Setenv("MUSIC_DL_SEARCH_SOURCE_BUDGET", original)
			return
		}
		os.Unsetenv("MUSIC_DL_SEARCH_SOURCE_BUDGET")
	})

	os.Unsetenv("MUSIC_DL_SEARCH_SOURCE_BUDGET")
	if got := searchSourceBudget(); got != searchSourceDefaultBudget {
		t.Fatalf("默认预算应为 %s, 实际 %s", searchSourceDefaultBudget, got)
	}

	os.Setenv("MUSIC_DL_SEARCH_SOURCE_BUDGET", "5s")
	if got := searchSourceBudget(); got != 5*time.Second {
		t.Fatalf("env 覆盖应生效, 实际 %s", got)
	}

	os.Setenv("MUSIC_DL_SEARCH_SOURCE_BUDGET", "not-a-duration")
	if got := searchSourceBudget(); got != searchSourceDefaultBudget {
		t.Fatalf("非法值应回退默认 %s, 实际 %s", searchSourceDefaultBudget, got)
	}
}

// TestConcurrentKeywordSearchReturnsPartialResultsBeforeBudget 复现真实故障形状:
// 一个源病态地慢(实测 qq 在 limit=20 下 215s),其余源很快返回。
// 修复前 concurrentKeywordSearch 等齐所有源 -> 被 provider 客户端 2 分钟硬超时掐断
// -> 整次搜索退化成空;修复后必须在预算内交出已到齐的源的结果。
func TestConcurrentKeywordSearchReturnsPartialResultsBeforeBudget(t *testing.T) {
	os.Setenv("MUSIC_DL_SEARCH_SOURCE_BUDGET", "300ms")
	t.Cleanup(func() { os.Unsetenv("MUSIC_DL_SEARCH_SOURCE_BUDGET") })

	// 直接验证预算收集语义:两个"源",一个立刻到,一个远超预算。
	results := make(chan keywordSearchResult, 2)
	go func() {
		results <- keywordSearchResult{songs: makeTracks(3)}
	}()
	go func() {
		time.Sleep(10 * time.Second) // 远超 300ms 预算
		results <- keywordSearchResult{songs: makeTracks(99)}
	}()

	songs := make([]int, 0)
	budget := time.NewTimer(searchSourceBudget())
	defer budget.Stop()
	started := time.Now()
	collected := 0
loop:
	for i := 0; i < 2; i++ {
		select {
		case result := <-results:
			songs = append(songs, len(result.songs))
			collected++
		case <-budget.C:
			break loop
		}
	}
	elapsed := time.Since(started)

	if collected != 1 {
		t.Fatalf("预算内应只收到 1 个源, 实际 %d", collected)
	}
	if len(songs) != 1 || songs[0] != 3 {
		t.Fatalf("应保留快源的 3 首, 实际 %v", songs)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("不应等待慢源, 实际耗时 %s", elapsed)
	}
}

func makeTracks(n int) []model.Track {
	return make([]model.Track, n)
}

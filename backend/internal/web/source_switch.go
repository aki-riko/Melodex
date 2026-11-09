package web

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

type switchCandidate struct {
	song               model.Track
	score              float64
	durationDifference int
}

type switchSearchResult struct {
	candidates []switchCandidate
}

var switchSearchFuncProvider = func(source string) func(string) ([]model.Track, error) {
	return core.GetSearchFunc(source)
}
var switchValidatePlayable = core.ValidatePlayable
var switchAllSourceNames = core.GetAllSourceNames
var switchDefaultSourceNames = core.GetDefaultSourceNames

const switchMaxCandidatesPerSource = 8
const switchSourceSearchTimeout = 6 * time.Second
const switchHighConfidenceScore = 0.98
const switchParallelValidationLimit = 12
const switchParallelValidationParallel = 6

// switchSearchConcurrency 限制"同时向上游发起的换源搜索"数量。
//
// 2026-11 之前这里是**每个源一个 goroutine 全部同时打出去**: 默认源 7 个 + 全量源
// 12 个去重后仍有 11 个, 每个源内部还会按 providerSearchLimit(=20)首去要候选, 而
// QQ/网易的取址是"每首歌一次 vkey + 音质阶梯探活"。实测一次 switch_source 让
// provider 在 2 秒内收到十几条 limit=20 的搜索(07:05:35~36 那段日志), 单分钟峰值
// 364 次 —— 直接把上游打成限流, 限流之后连正常播放取址都开始 104009/404。
//
// 换成限并发后仍然是"谁先给出高置信结果就用谁"(不等待慢尾, 见
// TestSourceSwitchReturnsHighConfidenceResultWithoutSlowTail), 只是同一时刻最多
// 这么多个源在打上游, 其余排队等前面完成。慢源被跳过后依然是整体超时兜底。
const switchSearchConcurrency = 4

func findBestSwitchSong(name, artist, current, target string, originalDuration int) (*model.Track, float64, error) {
	name, artist = strings.TrimSpace(name), strings.TrimSpace(artist)
	current, target = strings.TrimSpace(current), strings.TrimSpace(target)
	if name == "" {
		return nil, 0, fmt.Errorf("missing name")
	}
	sources := switchCandidateSources(current, target)
	if len(sources) == 0 {
		return nil, 0, fmt.Errorf("no match")
	}
	keyword := strings.TrimSpace(name + " " + artist)
	results := make(chan switchSearchResult, len(sources))
	// switchSearchDone 在高置信命中提前返回时关闭, 用来让还在排队等信号量的
	// goroutine 立刻退出 —— 否则它们会继续排队并在拿到槽位后白打一次上游。
	// 关闭后 select 走 <-switchSearchDone 分支返回, 不会阻塞等待。
	switchSearchDone := make(chan struct{})
	defer close(switchSearchDone)
	var searches sync.WaitGroup
	// 限并发: 见 switchSearchConcurrency 的注释。信号量在 goroutine 内部获取而不是
	// 阻塞在起 goroutine 处, 这样"消费端提前 return"(高置信命中)时不会留下卡住的发送方。
	slots := make(chan struct{}, switchSearchConcurrency)
	for _, source := range sources {
		search := switchSearchFuncProvider(source)
		searches.Add(1)
		go func() {
			defer searches.Done()
			select {
			case slots <- struct{}{}:
			case <-switchSearchDone:
				return
			}
			defer func() { <-slots }()
			candidates := searchSwitchSourceCandidates(source, search, keyword, name, artist, originalDuration)
			if len(candidates) > 0 {
				// 提前返回后 results 不再有人读, 但缓冲容量等于源数量, 所以这里不会阻塞。
				results <- switchSearchResult{candidates: candidates}
			}
		}()
	}
	go func() {
		searches.Wait()
		close(results)
	}()

	allCandidates := make([]switchCandidate, 0)
	for result := range results {
		sortSwitchCandidates(result.candidates)
		allCandidates = append(allCandidates, result.candidates...)
		best := result.candidates[0]
		if isHighConfidenceSwitchCandidate(best, originalDuration) && switchValidatePlayable(&best.song) {
			selected := best.song
			return &selected, best.score, nil
		}
	}
	if len(allCandidates) == 0 {
		return nil, 0, fmt.Errorf("no match")
	}
	sortSwitchCandidates(allCandidates)
	if selected, score, ok := validateSwitchCandidates(allCandidates); ok {
		return selected, score, nil
	}
	return nil, 0, fmt.Errorf("no playable match")
}

func switchCandidateSources(current, target string) []string {
	current, target = strings.TrimSpace(current), strings.TrimSpace(target)
	if target != "" {
		return explicitSwitchTarget(current, target)
	}
	seen := make(map[string]struct{})
	sources := make([]string, 0)
	for _, source := range switchDefaultSourceNames() {
		sources = appendEligibleSwitchSource(sources, seen, source, current)
	}
	for _, source := range switchAllSourceNames() {
		sources = appendEligibleSwitchSource(sources, seen, source, current)
	}
	return sources
}

func explicitSwitchTarget(current, target string) []string {
	if !isSwitchSourceAllowed(target, current) || switchSearchFuncProvider(target) == nil {
		return nil
	}
	return []string{target}
}

func appendEligibleSwitchSource(sources []string, seen map[string]struct{}, source, current string) []string {
	source = strings.TrimSpace(source)
	_, duplicate := seen[source]
	if duplicate || !isSwitchSourceAllowed(source, current) || switchSearchFuncProvider(source) == nil {
		return sources
	}
	seen[source] = struct{}{}
	return append(sources, source)
}

func isSwitchSourceAllowed(source, current string) bool {
	return source != "" && source != current && source != "soda" && source != "fivesing"
}

func searchSwitchSourceCandidates(source string, search func(string) ([]model.Track, error), keyword, name, artist string, originalDuration int) []switchCandidate {
	if search == nil {
		return nil
	}
	tracks, err := runSwitchSearch(search, keyword)
	if (err != nil || len(tracks) == 0) && artist != "" {
		tracks, _ = runSwitchSearch(search, name)
	}
	limit := min(len(tracks), switchMaxCandidatesPerSource)
	candidates := make([]switchCandidate, 0, limit)
	for _, track := range tracks[:limit] {
		track.Source = source
		score := core.CalcSongSimilarity(name, artist, track.Name, track.Artist)
		if score <= 0 {
			continue
		}
		difference := 0
		if originalDuration > 0 && track.Duration > 0 {
			difference = core.IntAbs(originalDuration - track.Duration)
			if !core.IsDurationClose(originalDuration, track.Duration) {
				continue
			}
		}
		candidates = append(candidates, switchCandidate{song: track, score: score, durationDifference: difference})
	}
	return candidates
}

func runSwitchSearch(search func(string) ([]model.Track, error), query string) ([]model.Track, error) {
	type response struct {
		tracks []model.Track
		err    error
	}
	done := make(chan response, 1)
	go func() {
		tracks, err := search(query)
		done <- response{tracks: tracks, err: err}
	}()
	select {
	case result := <-done:
		return result.tracks, result.err
	case <-time.After(switchSourceSearchTimeout):
		return nil, fmt.Errorf("search timeout")
	}
}

func sortSwitchCandidates(candidates []switchCandidate) {
	sort.SliceStable(candidates, func(left, right int) bool {
		if candidates[left].score != candidates[right].score {
			return candidates[left].score > candidates[right].score
		}
		return candidates[left].durationDifference < candidates[right].durationDifference
	})
}

func isHighConfidenceSwitchCandidate(candidate switchCandidate, originalDuration int) bool {
	return candidate.score >= switchHighConfidenceScore &&
		(originalDuration <= 0 || candidate.song.Duration <= 0 || candidate.durationDifference <= 3)
}

func validateSwitchCandidates(candidates []switchCandidate) (*model.Track, float64, bool) {
	candidates = candidates[:min(len(candidates), switchParallelValidationLimit)]
	if len(candidates) == 0 {
		return nil, 0, false
	}
	workerCount := min(len(candidates), switchParallelValidationParallel)
	jobs := make(chan int, len(candidates))
	results := make(chan struct {
		index int
		valid bool
	}, len(candidates))
	var workers sync.WaitGroup
	for range workerCount {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				results <- struct {
					index int
					valid bool
				}{index: index, valid: switchValidatePlayable(&candidates[index].song)}
			}
		}()
	}
	for index := range candidates {
		jobs <- index
	}
	close(jobs)
	workers.Wait()
	close(results)
	playable := make([]bool, len(candidates))
	for result := range results {
		playable[result.index] = result.valid
	}
	for index, valid := range playable {
		if valid {
			selected := candidates[index].song
			return &selected, candidates[index].score, true
		}
	}
	return nil, 0, false
}

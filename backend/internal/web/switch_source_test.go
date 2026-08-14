package web

import (
	"testing"
	"time"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

func withSwitchSourceTestHooks(t *testing.T) {
	t.Helper()

	origSearchProvider := switchSearchFuncProvider
	origValidatePlayable := switchValidatePlayable
	origAllSources := switchAllSourceNames
	origDefaultSources := switchDefaultSourceNames
	t.Cleanup(func() {
		switchSearchFuncProvider = origSearchProvider
		switchValidatePlayable = origValidatePlayable
		switchAllSourceNames = origAllSources
		switchDefaultSourceNames = origDefaultSources
	})
}

func TestFindBestSwitchSongReturnsBeforeSlowSourcesOnHighConfidenceMatch(t *testing.T) {
	withSwitchSourceTestHooks(t)

	switchAllSourceNames = func() []string { return []string{"slow", "fast"} }
	switchDefaultSourceNames = func() []string { return []string{"slow", "fast"} }
	switchSearchFuncProvider = func(source string) func(string) ([]model.Track, error) {
		switch source {
		case "slow":
			return func(string) ([]model.Track, error) {
				time.Sleep(2 * time.Second)
				return []model.Track{{ID: "slow-song", Name: "Track", Artist: "Artist", Duration: 180}}, nil
			}
		case "fast":
			return func(string) ([]model.Track, error) {
				return []model.Track{{ID: "fast-song", Name: "Track", Artist: "Artist", Duration: 180}}, nil
			}
		default:
			return nil
		}
	}
	switchValidatePlayable = func(song *model.Track) bool {
		return song != nil && song.ID == "fast-song"
	}

	start := time.Now()
	got, score, err := findBestSwitchSong("Track", "Artist", "netease", "", 180)
	if err != nil {
		t.Fatalf("findBestSwitchSong returned error: %v", err)
	}
	if got == nil || got.ID != "fast-song" || got.Source != "fast" {
		t.Fatalf("findBestSwitchSong selected %#v, want fast-song from fast", got)
	}
	if score < switchHighConfidenceScore {
		t.Fatalf("selected score = %f, want high confidence", score)
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("findBestSwitchSong waited for slow source, elapsed=%s", elapsed)
	}
}

func TestValidateSwitchCandidatesKeepsRankedOrderWithParallelChecks(t *testing.T) {
	withSwitchSourceTestHooks(t)

	switchValidatePlayable = func(song *model.Track) bool {
		if song != nil && song.ID == "best" {
			time.Sleep(100 * time.Millisecond)
			return true
		}
		return song != nil && song.ID == "second"
	}

	candidates := []switchCandidate{
		{song: model.Track{ID: "best", Source: "fast"}, score: 1},
		{song: model.Track{ID: "second", Source: "fast"}, score: 0.99},
	}
	got, score, ok := validateSwitchCandidates(candidates)
	if !ok {
		t.Fatal("validateSwitchCandidates returned no playable candidate")
	}
	if got == nil || got.ID != "best" || score != 1 {
		t.Fatalf("validateSwitchCandidates selected %#v score=%f, want best score=1", got, score)
	}
}

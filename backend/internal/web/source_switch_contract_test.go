package web

import (
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

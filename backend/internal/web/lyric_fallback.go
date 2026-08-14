package web

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

const (
	lyricFallbackFetchTimeout    = 6 * time.Second
	lyricFallbackMaxDurationDiff = 3
)

var lyricFuncProvider = core.GetLyricFunc

type lyricFallbackResult struct {
	lyric string
	song  model.Track
	err   error
}

func loadLyricWithFallback(song *model.Track) (string, *model.Track, error) {
	if song == nil {
		return "", nil, errors.New("missing song")
	}

	fn := lyricFuncProvider(song.Source)
	if fn == nil {
		return "", nil, fmt.Errorf("lyrics unsupported for source %q", song.Source)
	}
	lyric, primaryErr := fn(song)
	if strings.TrimSpace(lyric) != "" {
		return lyric, song, nil
	}
	if primaryErr == nil {
		primaryErr = errors.New("primary source returned empty lyric")
	}

	lyric, fallbackSong, fallbackErr := findFallbackLyric(song)
	if strings.TrimSpace(lyric) != "" && fallbackSong != nil {
		return lyric, fallbackSong, nil
	}
	return "", nil, errors.Join(primaryErr, fallbackErr)
}

// LoadLyricWithFallback exposes the same strict same-song fallback used by the
// Web lyric endpoint to trusted in-process maintenance commands.
func LoadLyricWithFallback(song *model.Track) (string, *model.Track, error) {
	return loadLyricWithFallback(song)
}

func findFallbackLyric(song *model.Track) (string, *model.Track, error) {
	name := strings.TrimSpace(song.Name)
	artist := strings.TrimSpace(song.Artist)
	if name == "" || artist == "" || song.Duration <= 0 {
		return "", nil, errors.New("incomplete song metadata for lyric fallback")
	}

	results, started := startFallbackLyricSearches(song)
	if started == 0 {
		return "", nil, errors.New("no lyric fallback sources")
	}

	var fallbackErr error
	for range started {
		result := <-results
		if strings.TrimSpace(result.lyric) != "" {
			matched := result.song
			return result.lyric, &matched, nil
		}
		fallbackErr = errors.Join(fallbackErr, result.err)
	}
	if fallbackErr == nil {
		fallbackErr = errors.New("no matching fallback lyric")
	}
	return "", nil, fallbackErr
}

func startFallbackLyricSearches(song *model.Track) (<-chan lyricFallbackResult, int) {
	sources := switchCandidateSources(song.Source, "")
	results := make(chan lyricFallbackResult, len(sources))
	started := 0
	for _, source := range sources {
		searchFn := switchSearchFuncProvider(source)
		lyricFn := lyricFuncProvider(source)
		if searchFn == nil || lyricFn == nil {
			continue
		}
		started++
		go func(source string, searchFn func(string) ([]model.Track, error), lyricFn func(*model.Track) (string, error)) {
			results <- searchFallbackLyricSource(song, source, searchFn, lyricFn)
		}(source, searchFn, lyricFn)
	}
	return results, started
}

func searchFallbackLyricSource(song *model.Track, source string, searchFn func(string) ([]model.Track, error), lyricFn func(*model.Track) (string, error)) lyricFallbackResult {
	keyword := strings.TrimSpace(song.Name + " " + song.Artist)
	candidates := searchSwitchSourceCandidates(source, searchFn, keyword, song.Name, song.Artist, song.Duration)
	sortSwitchCandidates(candidates)
	return fetchStrictLyricCandidates(song, source, candidates, lyricFn)
}

func fetchStrictLyricCandidates(song *model.Track, source string, candidates []switchCandidate, lyricFn func(*model.Track) (string, error)) lyricFallbackResult {
	var candidateErr error
	strictMatches := 0
	for _, candidate := range candidates {
		if !isStrictLyricFallbackCandidate(song, candidate) {
			continue
		}
		strictMatches++
		lyric, err := fetchLyricWithTimeout(lyricFn, &candidate.song)
		if strings.TrimSpace(lyric) != "" {
			return lyricFallbackResult{lyric: lyric, song: candidate.song}
		}
		if err != nil {
			candidateErr = errors.Join(candidateErr, fmt.Errorf("source %s song %s lyric failed: %w", source, candidate.song.ID, err))
			continue
		}
		candidateErr = errors.Join(candidateErr, fmt.Errorf("source %s song %s returned empty lyric", source, candidate.song.ID))
	}
	if strictMatches > 0 {
		return lyricFallbackResult{err: candidateErr}
	}
	return lyricFallbackResult{err: fmt.Errorf("source %s has no strict song match", source)}
}

func isStrictLyricFallbackCandidate(song *model.Track, candidate switchCandidate) bool {
	if song == nil || song.Duration <= 0 || candidate.song.Duration <= 0 {
		return false
	}
	if strings.TrimSpace(candidate.song.Source) == "" || strings.TrimSpace(candidate.song.ID) == "" {
		return false
	}
	name := core.NormalizeText(song.Name)
	candidateName := core.NormalizeText(candidate.song.Name)
	artist := core.NormalizeText(song.Artist)
	candidateArtist := core.NormalizeText(candidate.song.Artist)
	if name == "" || candidateName == "" || name != candidateName {
		return false
	}
	if artist == "" || candidateArtist == "" || artist != candidateArtist {
		return false
	}
	return core.IntAbs(song.Duration-candidate.song.Duration) <= lyricFallbackMaxDurationDiff
}

func fetchLyricWithTimeout(fn func(*model.Track) (string, error), song *model.Track) (string, error) {
	type response struct {
		lyric string
		err   error
	}
	done := make(chan response, 1)
	go func() {
		lyric, err := fn(song)
		done <- response{lyric: lyric, err: err}
	}()
	select {
	case result := <-done:
		return result.lyric, result.err
	case <-time.After(lyricFallbackFetchTimeout):
		return "", errors.New("lyric fetch timeout")
	}
}

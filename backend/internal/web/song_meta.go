package web

import (
	"regexp"
	"strings"
	"unicode"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

var (
	artistJoinWordPattern = regexp.MustCompile(`(?i)\s+(?:feat(?:uring)?\.?|ft\.?|with|x)\s+`)
	spacedArtistJoiner    = regexp.MustCompile("\\s+(?:/|\uFF0F|&|\uFF06)\\s+")
)

func normalizeArtistToken(artist string) string {
	return strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(artist))), " ")
}

func containsEastAsianRune(value string) bool {
	for _, character := range value {
		if unicode.In(character, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul) {
			return true
		}
	}
	return false
}

func isCommonArtistSeparator(character rune) bool {
	switch character {
	case '\u3001', ',', '\uFF0C', ';', '\uFF1B', '|':
		return true
	default:
		return false
	}
}

func trimArtistToken(value string) string {
	const edgeSeparators = "-_ /\uFF0F\u00B7\u2022|\\,\uFF0C\u3001;\uFF1B&\uFF06"
	return strings.TrimFunc(value, func(character rune) bool {
		return unicode.IsSpace(character) || strings.ContainsRune(edgeSeparators, character)
	})
}

func splitArtistTokens(artist string) []string {
	original := strings.TrimSpace(artist)
	if original == "" {
		return []string{}
	}

	segmented := artistJoinWordPattern.ReplaceAllString(original, "|")
	eastAsian := containsEastAsianRune(original)
	var builder strings.Builder
	for _, character := range segmented {
		separator := isCommonArtistSeparator(character)
		if eastAsian && (character == '/' || character == '\uFF0F' || character == '&' || character == '\uFF06') {
			separator = true
		}
		if separator {
			builder.WriteByte('|')
		} else {
			builder.WriteRune(character)
		}
	}
	segmented = builder.String()
	if !eastAsian {
		segmented = spacedArtistJoiner.ReplaceAllString(segmented, "|")
	}

	seen := make(map[string]struct{})
	artists := make([]string, 0)
	for _, candidate := range strings.Split(segmented, "|") {
		candidate = trimArtistToken(candidate)
		canonical := normalizeArtistToken(candidate)
		if canonical == "" {
			continue
		}
		if _, duplicate := seen[canonical]; duplicate {
			continue
		}
		seen[canonical] = struct{}{}
		artists = append(artists, candidate)
	}
	if len(artists) == 0 {
		return []string{original}
	}
	return artists
}

func filterSongsByExactArtist(songs []model.Track, exactArtist string) []model.Track {
	target := normalizeArtistToken(exactArtist)
	if target == "" {
		return songs
	}

	filtered := make([]model.Track, 0, len(songs))
	for _, song := range songs {
		for _, artist := range splitArtistTokens(song.Artist) {
			if normalizeArtistToken(artist) == target {
				filtered = append(filtered, song)
				break
			}
		}
	}
	return filtered
}

func songAlbumID(song model.Track) string {
	if explicit := strings.TrimSpace(song.AlbumID); explicit != "" {
		return explicit
	}
	return extraMapAlbumID(song.Extra)
}

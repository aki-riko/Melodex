package web

import (
	"regexp"
	"strings"
	"unicode"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

var artistWordSeparator = regexp.MustCompile(`(?i)\s+(feat(?:uring)?\.?|ft\.?|with|x)\s+`)
var westernSpacedSeparator = regexp.MustCompile(`\s+[/／&＆]\s+`)

func normalizeArtistToken(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(value), " "))
}

func containsEastAsianRune(value string) bool {
	for _, character := range value {
		if unicode.In(character, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul) {
			return true
		}
	}
	return false
}

func splitArtistTokens(value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return []string{}
	}
	eastAsian := containsEastAsianRune(value)
	segmented := artistWordSeparator.ReplaceAllString(value, "|")
	if !eastAsian {
		segmented = westernSpacedSeparator.ReplaceAllString(segmented, "|")
	}
	parts := strings.FieldsFunc(segmented, func(character rune) bool {
		switch character {
		case '|', '、', ',', '，', ';', '；':
			return true
		case '/', '／', '&', '＆':
			return eastAsian
		default:
			return false
		}
	})

	result := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, part := range parts {
		appendArtistToken(&result, seen, trimArtistToken(part))
	}
	if len(result) == 0 {
		return []string{value}
	}
	return result
}

func appendArtistToken(result *[]string, seen map[string]struct{}, value string) {
	key := normalizeArtistToken(value)
	if key == "" {
		return
	}
	if _, duplicate := seen[key]; duplicate {
		return
	}
	seen[key] = struct{}{}
	*result = append(*result, value)
}

func trimArtistToken(value string) string {
	return strings.TrimFunc(value, func(character rune) bool {
		return unicode.IsSpace(character) || strings.ContainsRune("-_ /／·•|\\,，、;；&＆", character)
	})
}

func filterSongsByExactArtist(songs []model.Track, exactArtist string) []model.Track {
	wanted := normalizeArtistToken(exactArtist)
	if wanted == "" {
		return songs
	}
	result := make([]model.Track, 0, len(songs))
	for _, song := range songs {
		for _, artist := range splitArtistTokens(song.Artist) {
			if normalizeArtistToken(artist) == wanted {
				result = append(result, song)
				break
			}
		}
	}
	return result
}

func songAlbumID(song model.Track) string {
	if albumID := strings.TrimSpace(song.AlbumID); albumID != "" {
		return albumID
	}
	return extraMapAlbumID(song.Extra)
}

func normalizeLookupText(value string) string {
	return strings.Map(func(character rune) rune {
		if unicode.IsSpace(character) {
			return -1
		}
		switch character {
		case '（':
			return '('
		case '）':
			return ')'
		case '【':
			return '['
		case '】':
			return ']'
		case '“', '”':
			return '"'
		case '‘', '’':
			return '\''
		default:
			return unicode.ToLower(character)
		}
	}, strings.TrimSpace(value))
}

func pickBestAlbumMatch(name, artist string, albums []model.RemoteCollection) *model.RemoteCollection {
	if len(albums) == 0 {
		return nil
	}
	targetName := normalizeLookupText(name)
	targetArtists := splitArtistTokens(artist)
	bestIndex, bestScore := 0, -1
	for index, album := range albums {
		if score := albumMatchScore(targetName, targetArtists, album); score > bestScore {
			bestIndex, bestScore = index, score
		}
	}
	return &albums[bestIndex]
}

func albumMatchScore(targetName string, targetArtists []string, album model.RemoteCollection) int {
	score := textMatchScore(targetName, normalizeLookupText(album.Name), 100, 60)
	creatorTokens := splitArtistTokens(album.Creator)
	creatorText := normalizeLookupText(album.Creator)
	for _, artist := range targetArtists {
		canonical := normalizeArtistToken(artist)
		for _, creator := range creatorTokens {
			if canonical != "" && normalizeArtistToken(creator) == canonical {
				return score + 30
			}
		}
		if textMatchScore(normalizeLookupText(artist), creatorText, 10, 10) > 0 {
			return score + 10
		}
	}
	return score
}

func textMatchScore(left, right string, exact, partial int) int {
	if left == "" || right == "" {
		return 0
	}
	if left == right {
		return exact
	}
	if strings.Contains(left, right) || strings.Contains(right, left) {
		return partial
	}
	return 0
}

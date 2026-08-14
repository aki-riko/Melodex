package web

import (
	"strings"
	"unicode"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

func normalizeLookupText(value string) string {
	var normalized strings.Builder
	for _, character := range strings.ToLower(strings.TrimSpace(value)) {
		if unicode.IsSpace(character) {
			continue
		}
		switch character {
		case '\uFF08':
			character = '('
		case '\uFF09':
			character = ')'
		case '\u3010':
			character = '['
		case '\u3011':
			character = ']'
		case '\u201C', '\u201D':
			character = '"'
		case '\u2018', '\u2019':
			character = '\''
		}
		normalized.WriteRune(character)
	}
	return normalized.String()
}

func pickBestAlbumMatch(name string, artist string, albums []model.RemoteCollection) *model.RemoteCollection {
	if len(albums) == 0 {
		return nil
	}

	targetName := normalizeLookupText(name)
	targetArtists := splitArtistTokens(artist)
	bestIndex := 0
	bestScore := albumMatchScore(targetName, targetArtists, albums[0])
	for index := 1; index < len(albums); index++ {
		score := albumMatchScore(targetName, targetArtists, albums[index])
		if score > bestScore {
			bestIndex = index
			bestScore = score
		}
	}
	return &albums[bestIndex]
}

func albumMatchScore(targetName string, targetArtists []string, album model.RemoteCollection) int {
	score := 0
	albumName := normalizeLookupText(album.Name)
	if targetName != "" && albumName == targetName {
		score += 100
	} else if targetName != "" && albumName != "" &&
		(strings.Contains(albumName, targetName) || strings.Contains(targetName, albumName)) {
		score += 60
	}

	creatorTokens := splitArtistTokens(album.Creator)
	creatorText := normalizeLookupText(album.Creator)
	for _, targetArtist := range targetArtists {
		targetCanonical := normalizeArtistToken(targetArtist)
		if targetCanonical == "" {
			continue
		}
		for _, creator := range creatorTokens {
			if normalizeArtistToken(creator) == targetCanonical {
				return score + 30
			}
		}
		targetText := normalizeLookupText(targetArtist)
		if targetText != "" && creatorText != "" &&
			(strings.Contains(creatorText, targetText) || strings.Contains(targetText, creatorText)) {
			return score + 10
		}
	}
	return score
}

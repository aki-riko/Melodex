package core

import (
	"strings"
	"unicode"
)

func IsDurationClose(first, second int) bool {
	if first <= 0 || second <= 0 {
		return true
	}
	allowedDifference := max(10, int(float64(first)*0.15))
	return IntAbs(first-second) <= allowedDifference
}

func IntAbs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

func CalcSongSimilarity(name, artist, candidateName, candidateArtist string) float64 {
	nameScore := SimilarityScore(NormalizeText(name), NormalizeText(candidateName))
	if nameScore == 0 {
		return 0
	}
	leftArtist := NormalizeText(artist)
	rightArtist := NormalizeText(candidateArtist)
	if leftArtist == "" || rightArtist == "" {
		return nameScore
	}
	return nameScore*0.7 + SimilarityScore(leftArtist, rightArtist)*0.3
}

func NormalizeText(value string) string {
	var normalized strings.Builder
	for _, character := range strings.ToLower(value) {
		if unicode.IsLetter(character) || unicode.IsNumber(character) {
			normalized.WriteRune(character)
		}
	}
	return normalized.String()
}

func SimilarityScore(first, second string) float64 {
	if first == second {
		return 1
	}
	if first == "" || second == "" {
		return 0
	}
	maximumLength := max(len([]rune(first)), len([]rune(second)))
	distance := LevenshteinDistance(first, second)
	if distance >= maximumLength {
		return 0
	}
	return 1 - float64(distance)/float64(maximumLength)
}

func LevenshteinDistance(first, second string) int {
	left := []rune(first)
	right := []rune(second)
	if len(left) < len(right) {
		left, right = right, left
	}
	if len(right) == 0 {
		return len(left)
	}

	row := make([]int, len(right)+1)
	for column := range row {
		row[column] = column
	}
	for line, leftRune := range left {
		previousDiagonal := row[0]
		row[0] = line + 1
		for column, rightRune := range right {
			above := row[column+1]
			replacementCost := 0
			if leftRune != rightRune {
				replacementCost = 1
			}
			row[column+1] = min(row[column+1]+1, row[column]+1, previousDiagonal+replacementCost)
			previousDiagonal = above
		}
	}
	return row[len(right)]
}

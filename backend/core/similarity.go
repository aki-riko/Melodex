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

// SameTitleAndArtist 判断两个候选是不是"同一个作品"——歌名与歌手**归一化后完全相等**。
//
// 换源时这是最强的信号，比 CalcSongSimilarity 的高分更有意义：
// 相似度 0.95 仍然可能是"晴天"对"晴天 (Live)"，而换源换错版本对用户是明确的错误
// （听到的是另一个版本/另一个人的歌）。用户要求「换源应该优先换同歌名歌手的」，
// 依据就是这条。
//
// 归一化规则与 CalcSongSimilarity 一致（NormalizeText：只保留字母数字、转小写），
// 所以「周杰伦 / 周杰倫」「周杰伦、某某」这类写法差异会被折掉——
// 注意后者折成"周杰伦某某"，与"周杰伦"并不相等，属于**刻意保守**：
// 合唱/feat. 版本不是同一份录音，不该被当成"同歌手"。
func SameTitleAndArtist(name, artist, candidateName, candidateArtist string) bool {
	leftName := NormalizeText(name)
	rightName := NormalizeText(candidateName)
	if leftName == "" || rightName == "" || leftName != rightName {
		return false
	}
	leftArtist := NormalizeText(artist)
	rightArtist := NormalizeText(candidateArtist)
	if leftArtist == "" || rightArtist == "" {
		return false
	}
	return leftArtist == rightArtist
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

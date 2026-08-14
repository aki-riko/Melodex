package web

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	lyricFormatKaraoke = "karaoke"
	lyricFormatLine    = "line"
)

var (
	lrcTimestampRe = regexp.MustCompile(`\[(\d+):(\d+)\.(\d{1,3})\]`)
	lrcTagLineRe   = regexp.MustCompile(`^\[[A-Za-z]+:[^\]]*\]$`)
)

type parsedLyricLine struct {
	leadingTimestamp string
	positionMillis   int64
	text             string
	timestampCount   int
}

func parseTimedLyricLine(line string) (parsedLyricLine, bool) {
	line = strings.TrimSpace(line)
	matches := lrcTimestampRe.FindAllStringSubmatch(line, -1)
	if len(matches) == 0 {
		return parsedLyricLine{}, false
	}
	minutes, _ := strconv.ParseInt(matches[0][1], 10, 64)
	seconds, _ := strconv.ParseInt(matches[0][2], 10, 64)
	fraction := matches[0][3]
	fractionValue, _ := strconv.ParseInt(fraction, 10, 64)
	switch len(fraction) {
	case 1:
		fractionValue *= 100
	case 2:
		fractionValue *= 10
	}
	return parsedLyricLine{
		leadingTimestamp: matches[0][0],
		positionMillis:   (minutes*60+seconds)*1000 + fractionValue,
		text:             strings.TrimSpace(lrcTimestampRe.ReplaceAllString(line, "")),
		timestampCount:   len(matches),
	}, true
}

func classifyLyricFormat(raw string) string {
	seenStarts := make(map[int64]struct{})
	for _, line := range strings.Split(raw, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || lrcTagLineRe.MatchString(trimmed) {
			continue
		}
		parsed, ok := parseTimedLyricLine(trimmed)
		if !ok {
			continue
		}
		if parsed.timestampCount > 1 {
			return lyricFormatKaraoke
		}
		if _, duplicate := seenStarts[parsed.positionMillis]; duplicate {
			return lyricFormatKaraoke
		}
		seenStarts[parsed.positionMillis] = struct{}{}
	}
	return lyricFormatLine
}

func formatLyricForMode(raw string, mode string) string {
	if strings.EqualFold(strings.TrimSpace(mode), lyricFormatLine) {
		return lyricOriginalLineOnly(raw)
	}
	return raw
}

func lyricOriginalLineOnly(raw string) string {
	metadata := make([]string, 0)
	lyrics := make([]parsedLyricLine, 0)
	seenStarts := make(map[int64]struct{})

	for _, line := range strings.Split(raw, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if lrcTagLineRe.MatchString(trimmed) {
			metadata = append(metadata, trimmed)
			continue
		}
		parsed, ok := parseTimedLyricLine(trimmed)
		if !ok || parsed.text == "" {
			continue
		}
		if _, duplicate := seenStarts[parsed.positionMillis]; duplicate {
			continue
		}
		seenStarts[parsed.positionMillis] = struct{}{}
		lyrics = append(lyrics, parsed)
	}

	sort.SliceStable(lyrics, func(left, right int) bool {
		return lyrics[left].positionMillis < lyrics[right].positionMillis
	})

	var output strings.Builder
	for _, tag := range metadata {
		output.WriteString(tag)
		output.WriteByte('\n')
	}
	if len(metadata) > 0 && len(lyrics) > 0 {
		output.WriteByte('\n')
	}
	for _, line := range lyrics {
		output.WriteString(line.leadingTimestamp)
		output.WriteString(line.text)
		output.WriteByte('\n')
	}
	return strings.TrimRight(output.String(), "\n")
}

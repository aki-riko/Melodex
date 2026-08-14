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

var lyricTimestampPattern = regexp.MustCompile(`\[(\d+):(\d+)\.(\d{1,3})\]`)
var lyricMetadataPattern = regexp.MustCompile(`^\[[A-Za-z]+:[^\]]*\]$`)

type parsedLyricLine struct {
	leadingTimestamp string
	positionMillis   int64
	text             string
	timestampCount   int
}

func parseTimedLyricLine(raw string) (parsedLyricLine, bool) {
	raw = strings.TrimSpace(raw)
	matches := lyricTimestampPattern.FindAllStringSubmatch(raw, -1)
	if len(matches) == 0 {
		return parsedLyricLine{}, false
	}
	position, ok := timestampMillis(matches[0][1], matches[0][2], matches[0][3])
	if !ok {
		return parsedLyricLine{}, false
	}
	return parsedLyricLine{
		leadingTimestamp: matches[0][0], positionMillis: position,
		text:           strings.TrimSpace(lyricTimestampPattern.ReplaceAllString(raw, "")),
		timestampCount: len(matches),
	}, true
}

func timestampMillis(minutesRaw, secondsRaw, fractionRaw string) (int64, bool) {
	minutes, minuteErr := strconv.ParseInt(minutesRaw, 10, 64)
	seconds, secondErr := strconv.ParseInt(secondsRaw, 10, 64)
	fraction, fractionErr := strconv.ParseInt(fractionRaw, 10, 64)
	if minuteErr != nil || secondErr != nil || fractionErr != nil || seconds >= 60 {
		return 0, false
	}
	for digits := len(fractionRaw); digits < 3; digits++ {
		fraction *= 10
	}
	return (minutes*60+seconds)*1000 + fraction, true
}

func classifyLyricFormat(raw string) string {
	seen := make(map[int64]struct{})
	for _, rawLine := range strings.Split(raw, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || lyricMetadataPattern.MatchString(line) {
			continue
		}
		parsed, ok := parseTimedLyricLine(line)
		if !ok {
			continue
		}
		if parsed.timestampCount > 1 {
			return lyricFormatKaraoke
		}
		if _, duplicate := seen[parsed.positionMillis]; duplicate {
			return lyricFormatKaraoke
		}
		seen[parsed.positionMillis] = struct{}{}
	}
	return lyricFormatLine
}

func formatLyricForMode(raw, mode string) string {
	if strings.EqualFold(strings.TrimSpace(mode), lyricFormatLine) {
		return lyricOriginalLineOnly(raw)
	}
	return raw
}

func lyricOriginalLineOnly(raw string) string {
	metadata, timed := collectOriginalLyricLines(raw)
	sort.SliceStable(timed, func(i, j int) bool { return timed[i].positionMillis < timed[j].positionMillis })
	lines := make([]string, 0, len(metadata)+len(timed)+1)
	lines = append(lines, metadata...)
	if len(metadata) > 0 && len(timed) > 0 {
		lines = append(lines, "")
	}
	for _, line := range timed {
		lines = append(lines, line.leadingTimestamp+line.text)
	}
	return strings.Join(lines, "\n")
}

func collectOriginalLyricLines(raw string) ([]string, []parsedLyricLine) {
	metadata := make([]string, 0)
	timed := make([]parsedLyricLine, 0)
	seen := make(map[int64]struct{})
	for _, rawLine := range strings.Split(raw, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}
		if lyricMetadataPattern.MatchString(line) {
			metadata = append(metadata, line)
			continue
		}
		parsed, ok := parseTimedLyricLine(line)
		if !ok || parsed.text == "" {
			continue
		}
		if _, duplicate := seen[parsed.positionMillis]; duplicate {
			continue
		}
		seen[parsed.positionMillis] = struct{}{}
		timed = append(timed, parsed)
	}
	return metadata, timed
}

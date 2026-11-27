package web

import (
	"context"
	"log"
	"strings"
	"unicode"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/bridge"
)

// 仅用于避免给单语歌曲发校对请求。删行必须有音源提供的时间和文本两项依据。
func mayHaveTranslations(lyrics string) bool {
	var scripts uint8
	for line := range strings.SplitSeq(lyrics, "\n") {
		line = strings.TrimSpace(line)
		if len(line) < 2 || line[0] != '[' || line[1] < '0' || line[1] > '9' {
			continue
		}
		for _, r := range line {
			switch {
			case unicode.Is(unicode.Latin, r):
				scripts |= 1
			case unicode.Is(unicode.Han, r):
				scripts |= 2
			case unicode.IsOneOf([]*unicode.RangeTable{unicode.Hiragana, unicode.Katakana}, r):
				scripts |= 4
			case unicode.Is(unicode.Hangul, r):
				scripts |= 8
			}
			if scripts&(scripts-1) != 0 {
				return true
			}
		}
	}
	return false
}

type lyricLineIdentity struct {
	start int64
	text  string
}

func omitTranslationLines(lyrics, translations string) string {
	keys := make(map[lyricLineIdentity]bool)
	for row := range strings.SplitSeq(translations, "\n") {
		if line, ok := parseTimedLyricLine(row); ok {
			keys[lyricLineIdentity{line.positionMillis, line.text}] = true
		}
	}
	rows := strings.Split(lyrics, "\n")
	kept := rows[:0]
	for _, row := range rows {
		line, ok := parseTimedLyricLine(row)
		if !ok || !keys[lyricLineIdentity{line.positionMillis, line.text}] {
			kept = append(kept, row)
		}
	}
	if len(kept) == len(rows) || len(kept) == 0 {
		return lyrics
	}
	return strings.Join(kept, "\n")
}

func correctStoredLyrics(ctx context.Context, source, id, lyrics string) string {
	if source != "qq" || id == "" || !mayHaveTranslations(lyrics) {
		return lyrics
	}
	const namespace = "inline_translations:v1"
	args := apiCacheArgs{Source: source, ID: id}
	key := apiCacheKey(namespace, args)
	var translations string
	if entry, ok := getAPICacheEntry(key); ok && decodeAPICachePayload(entry, &translations) {
		return omitTranslationLines(lyrics, translations)
	}
	client, err := core.NewProviderBridgeClient()
	if err != nil {
		return lyrics
	}
	ctx, cancel := context.WithTimeout(ctx, lyricFallbackFetchTimeout)
	defer cancel()
	translations, err = client.Lyric(ctx, bridge.LyricRequest{
		Source: source, ID: id, Cookie: core.CookieForSource(source), InlineTranslations: true,
	})
	if err != nil {
		log.Printf("[lyric] 核对已保存歌词失败 source=%s id=%s: %v", source, id, err)
		return lyrics
	}
	if translations == "" {
		return lyrics
	}
	putAPICache(key, namespace, args, translations)
	return omitTranslationLines(lyrics, translations)
}

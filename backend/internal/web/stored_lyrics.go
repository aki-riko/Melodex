package web

import (
	"context"
	"log"
	"strconv"
	"strings"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/bridge"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

type lyricLineIdentity struct {
	start int64
	text  string
}

// 译文与原句使用同一个行首时间，客户端只给分组首行逐字填色。
func bilingualLyrics(lyrics string, reference bridge.LyricTranslations) string {
	if len(reference.Pairs) == 0 {
		return lyrics
	}
	pairs := make(map[lyricLineIdentity]string)
	for _, pair := range reference.Pairs {
		key := lyricLineIdentity{pair.MS, strings.TrimSpace(pair.Source)}
		if pair.Text != "" && pair.Text != key.text {
			pairs[key] = pair.Text
		}
	}
	duplicates := make(map[lyricLineIdentity]bool)
	for row := range strings.SplitSeq(reference.InlineTranslations, "\n") {
		if line, ok := parseTimedLyricLine(row); ok {
			duplicates[lyricLineIdentity{line.positionMillis, line.text}] = true
		}
	}
	var result []string
	activeTranslation := ""
	var activeStart int64
	for row := range strings.SplitSeq(lyrics, "\n") {
		line, ok := parseTimedLyricLine(row)
		if !ok {
			result = append(result, row)
			continue
		}
		key := lyricLineIdentity{line.positionMillis, line.text}
		translation := pairs[key]
		// 酷我把同一录音的毫秒时间截成厘秒。仍须原句文本逐字一致。
		if translation == "" && line.positionMillis%10 == 0 {
			for offset := int64(1); offset < 10 && translation == ""; offset++ {
				translation = pairs[lyricLineIdentity{line.positionMillis + offset, line.text}]
			}
		}
		if translation != "" {
			result = append(result, row, line.leadingTimestamp+translation)
			activeTranslation, activeStart = translation, line.positionMillis
		} else if activeTranslation != "" && (duplicates[key] || (activeStart == line.positionMillis && activeTranslation == line.text)) {
			continue
		} else {
			result = append(result, row)
			activeTranslation = ""
		}
	}
	return strings.Join(result, "\n")
}

func correctStoredLyrics(ctx context.Context, track *model.Track, lyrics string) string {
	if track == nil || track.ID == "" || track.Source == "" || !lyricTimestampPattern.MatchString(lyrics) {
		return lyrics
	}
	source, id := track.Source, track.ID
	if source != "qq" && source != "netease" && (track.Name == "" || track.Artist == "" || track.Duration <= 0) {
		return lyrics
	}
	const namespace = "bilingual_lyrics:v2"
	args := apiCacheArgs{Source: source, ID: id}
	if source != "qq" && source != "netease" {
		args.Recording = []string{track.Name, track.Artist, strconv.Itoa(track.Duration)}
	}
	key := apiCacheKey(namespace, args)
	var translations bridge.LyricTranslations
	if entry, ok := getAPICacheEntry(key); ok && decodeAPICachePayload(entry, &translations) {
		return bilingualLyrics(lyrics, translations)
	}
	client, err := core.NewProviderBridgeClient()
	if err != nil {
		return lyrics
	}
	ctx, cancel := context.WithTimeout(ctx, lyricFallbackFetchTimeout)
	defer cancel()
	request := bridge.LyricRequest{
		Source: source, ID: id, Name: track.Name, Artist: track.Artist, Duration: track.Duration,
		InlineTranslations: true,
	}
	if source == "qq" {
		request.Cookie = core.CookieForSource(source)
	}
	translations, err = client.Translations(ctx, request)
	if err != nil {
		log.Printf("[lyric] 核对已保存歌词失败 source=%s id=%s: %v", source, id, err)
		return lyrics
	}
	if len(translations.Pairs) == 0 {
		return lyrics
	}
	putAPICache(key, namespace, args, translations)
	return bilingualLyrics(lyrics, translations)
}

package core

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/guohuiyuan/go-music-dl/internal/provider/bridge"
	providermodel "github.com/guohuiyuan/go-music-dl/internal/provider/model"
	legacymodel "github.com/guohuiyuan/music-lib/model"
)

const (
	providerBridgeURLEnv = "MUSIC_DL_PROVIDER_URL"
	providerSongCacheTTL = 10 * time.Minute
)

var providerBridgeSources = map[string]struct{}{
	"apple": {}, "bilibili": {}, "fivesing": {}, "jamendo": {},
	"joox": {}, "kugou": {}, "kuwo": {}, "migu": {},
	"netease": {}, "qianqian": {}, "qq": {}, "soda": {},
}

type providerSongCacheEntry struct {
	song      providermodel.Song
	expiresAt time.Time
}

type providerHeaderCacheEntry struct {
	headers   http.Header
	expiresAt time.Time
}

var (
	providerBridgeClientMu  sync.Mutex
	providerBridgeClientURL string
	providerBridgeClient    *bridge.Client
	providerSongCache       sync.Map
	providerHeaderCache     sync.Map
)

func providerBridgeSupports(source string) bool {
	_, ok := providerBridgeSources[strings.TrimSpace(source)]
	return ok
}

func getProviderBridgeClient() (*bridge.Client, error) {
	rawURL := strings.TrimSpace(os.Getenv(providerBridgeURLEnv))
	if rawURL == "" {
		return nil, fmt.Errorf("%s is required", providerBridgeURLEnv)
	}

	providerBridgeClientMu.Lock()
	defer providerBridgeClientMu.Unlock()
	if providerBridgeClient != nil && providerBridgeClientURL == rawURL {
		return providerBridgeClient, nil
	}
	client, err := bridge.NewClient(rawURL, &http.Client{Timeout: 2 * time.Minute})
	if err != nil {
		return nil, err
	}
	providerBridgeClientURL = rawURL
	providerBridgeClient = client
	return client, nil
}

func searchProviderSongs(source, keyword, cookie string) ([]legacymodel.Song, error) {
	client, err := getProviderBridgeClient()
	if err != nil {
		return nil, err
	}
	songs, err := client.Search(context.Background(), bridge.SearchRequest{
		Source: source, Keyword: keyword, Limit: 20, Cookie: cookie,
	})
	if err != nil {
		return nil, err
	}
	publicSongs := make([]legacymodel.Song, 0, len(songs))
	for _, song := range songs {
		cacheProviderSong(song, cookie)
		publicSongs = append(publicSongs, publicProviderSong(song))
	}
	return publicSongs, nil
}

func resolveProviderSong(source string, song *legacymodel.Song, cookie string) (providermodel.Song, error) {
	if song == nil {
		return providermodel.Song{}, errors.New("song is nil")
	}
	if cached, ok := loadProviderSong(source, song.ID, cookie); ok {
		return cached, nil
	}

	keyword := strings.TrimSpace(song.Extra["provider_lookup"])
	if keyword == "" {
		keyword = strings.TrimSpace(strings.Join([]string{song.Name, song.Artist}, " "))
	}
	if keyword == "" {
		keyword = strings.TrimSpace(song.ID)
	}
	if keyword == "" {
		return providermodel.Song{}, errors.New("missing provider lookup data")
	}

	client, err := getProviderBridgeClient()
	if err != nil {
		return providermodel.Song{}, err
	}
	candidates, err := client.Search(context.Background(), bridge.SearchRequest{
		Source: source, Keyword: keyword, Limit: 20, Cookie: cookie,
	})
	if err != nil {
		return providermodel.Song{}, err
	}
	for _, candidate := range candidates {
		cacheProviderSong(candidate, cookie)
		if strings.TrimSpace(candidate.ID) == strings.TrimSpace(song.ID) {
			return candidate, nil
		}
	}
	if len(candidates) == 0 {
		return providermodel.Song{}, errors.New("provider returned no matching songs")
	}

	bestIndex := -1
	bestScore := 0.0
	for i := range candidates {
		score := CalcSongSimilarity(song.Name, song.Artist, candidates[i].Name, candidates[i].Artist)
		if score > bestScore {
			bestIndex = i
			bestScore = score
		}
	}
	if bestIndex < 0 || bestScore < 0.75 {
		return providermodel.Song{}, errors.New("provider returned no matching song identity")
	}
	return candidates[bestIndex], nil
}

func providerDownloadURL(source string, song *legacymodel.Song) (string, error) {
	resolved, err := resolveProviderSong(source, song, cookieForSource(source))
	if err != nil {
		return "", err
	}
	urlStr := strings.TrimSpace(resolved.URL)
	if urlStr == "" || resolved.IsInvalid {
		return "", errors.New("provider returned an invalid download URL")
	}
	return urlStr, nil
}

func providerLyrics(source string, song *legacymodel.Song) (string, error) {
	resolved, err := resolveProviderSong(source, song, cookieForSource(source))
	if err != nil {
		return "", err
	}
	lyric := strings.TrimSpace(resolved.Extra["lyric"])
	if lyric == "" {
		return "", errors.New("provider returned no lyrics")
	}
	return lyric, nil
}

func cacheProviderSong(song providermodel.Song, cookie string) {
	song.Source = strings.TrimSpace(song.Source)
	song.ID = strings.TrimSpace(song.ID)
	if song.Source == "" || song.ID == "" {
		return
	}
	entry := providerSongCacheEntry{song: cloneProviderSong(song), expiresAt: time.Now().Add(providerSongCacheTTL)}
	providerSongCache.Store(providerSongCacheKey(song.Source, song.ID, cookie), entry)
	cacheProviderHeaders(song)
}

func loadProviderSong(source, id, cookie string) (providermodel.Song, bool) {
	key := providerSongCacheKey(source, id, cookie)
	raw, ok := providerSongCache.Load(key)
	if !ok {
		return providermodel.Song{}, false
	}
	entry, ok := raw.(providerSongCacheEntry)
	if !ok || time.Now().After(entry.expiresAt) {
		providerSongCache.Delete(key)
		return providermodel.Song{}, false
	}
	return cloneProviderSong(entry.song), true
}

func providerSongCacheKey(source, id, cookie string) string {
	digest := sha1.Sum([]byte(strings.TrimSpace(cookie)))
	return strings.TrimSpace(source) + "\x00" + strings.TrimSpace(id) + "\x00" + hex.EncodeToString(digest[:])
}

func publicProviderSong(song providermodel.Song) legacymodel.Song {
	extra := cloneStringMap(song.Extra)
	delete(extra, "download_headers")
	delete(extra, "lyric")
	if extra == nil {
		extra = make(map[string]string)
	}
	lookup := strings.TrimSpace(strings.Join([]string{song.Name, song.Artist}, " "))
	if lookup != "" {
		extra["provider_lookup"] = lookup
	}
	return legacymodel.Song{
		ID: song.ID, Name: song.Name, Artist: song.Artist, Album: song.Album,
		AlbumID: song.AlbumID, Duration: song.Duration, Size: song.Size,
		Bitrate: song.Bitrate, Source: song.Source, Ext: song.Ext,
		Cover: song.Cover, Link: song.Link, Extra: extra,
		IsInvalid: song.IsInvalid, IsVIP: song.IsVIP,
	}
}

func cloneProviderSong(song providermodel.Song) providermodel.Song {
	song.Extra = cloneStringMap(song.Extra)
	return song
}

func cloneStringMap(values map[string]string) map[string]string {
	if values == nil {
		return nil
	}
	cloned := make(map[string]string, len(values))
	for key, value := range values {
		cloned[key] = value
	}
	return cloned
}

func cacheProviderHeaders(song providermodel.Song) {
	urlStr := strings.TrimSpace(song.URL)
	rawHeaders := strings.TrimSpace(song.Extra["download_headers"])
	if urlStr == "" || rawHeaders == "" {
		return
	}
	var values map[string]interface{}
	if err := json.Unmarshal([]byte(rawHeaders), &values); err != nil {
		return
	}
	headers := make(http.Header)
	for key, rawValue := range values {
		value, ok := rawValue.(string)
		if !ok || !providerHeaderAllowed(key, value) {
			continue
		}
		headers.Set(key, value)
	}
	if len(headers) > 0 {
		providerHeaderCache.Store(urlStr, providerHeaderCacheEntry{
			headers: headers, expiresAt: time.Now().Add(providerSongCacheTTL),
		})
	}
}

func providerHeaderAllowed(key, value string) bool {
	if strings.ContainsAny(key, "\r\n") || strings.ContainsAny(value, "\r\n") {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "", "connection", "content-length", "host", "proxy-connection", "range", "transfer-encoding":
		return false
	default:
		return true
	}
}

func applyProviderMediaHeaders(request *http.Request, urlStr string) {
	raw, ok := providerHeaderCache.Load(strings.TrimSpace(urlStr))
	if !ok {
		return
	}
	entry, ok := raw.(providerHeaderCacheEntry)
	if !ok || time.Now().After(entry.expiresAt) {
		providerHeaderCache.Delete(strings.TrimSpace(urlStr))
		return
	}
	for key, values := range entry.headers {
		request.Header.Del(key)
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
}

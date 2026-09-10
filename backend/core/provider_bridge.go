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

	"github.com/aki-riko/Melodex/backend/internal/provider/bridge"
	providermodel "github.com/aki-riko/Melodex/backend/internal/provider/model"
)

const (
	providerBridgeURLEnv = "MUSIC_DL_PROVIDER_URL"
	providerSongCacheTTL = 10 * time.Minute

	// providerSearchLimitEnv 是单源搜索的候选数。
	//
	// 上游是按"每首歌都要解析一次下载地址"计费的, 实测延迟近似线性于该值: 同一批源
	// limit=1 时 netease 7.6s / migu 7.4s / kuwo 6.2s, limit=20 时 migu 63s /
	// kuwo 99s / netease 211s。所以允许用环境变量下调以换取响应速度; 默认值保持
	// 改动前的 20 不变, 避免静默改变用户看到的候选数量。
	providerSearchLimitEnv     = "MUSIC_DL_PROVIDER_SEARCH_LIMIT"
	providerSearchLimitDefault = 20
	providerSearchLimitMax     = 100
)

var providerBridgeSources = map[string]struct{}{
	"apple": {}, "bilibili": {}, "fivesing": {}, "jamendo": {},
	"joox": {}, "kugou": {}, "kuwo": {}, "migu": {},
	"netease": {}, "qianqian": {}, "qq": {}, "soda": {},
}

type providerSongCacheEntry struct {
	song      providermodel.Track
	expiresAt time.Time
}

type providerHeaderCacheEntry struct {
	headers   http.Header
	expiresAt time.Time
}

type ProviderMedia struct {
	URL      string
	PlayAuth string
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

// providerSearchLimit 返回单源搜索候选数(可用 MUSIC_DL_PROVIDER_SEARCH_LIMIT 覆盖)。
func providerSearchLimit() int {
	limit := intEnv(providerSearchLimitEnv, providerSearchLimitDefault)
	if limit > providerSearchLimitMax {
		return providerSearchLimitMax
	}
	return limit
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

// providerSearchTypeSong / providerSearchTypeLyric 是传给 sidecar 的搜索类型。
// QQ 的搜歌接口原生支持按歌词片段检索(search_type=7): 实测搜「故事的小黄花」直接命中
// 晴天/周杰伦、搜「天青色等烟雨」命中青花瓷/周杰伦, 而 0(普通搜歌)只会返回同名噪音。
// 其他源不区分类型, 非 0 也只按标题/歌手搜。
const (
	providerSearchTypeSong  = 0
	providerSearchTypeLyric = 7
)

func searchProviderSongs(source, keyword, cookie string) ([]providermodel.Track, error) {
	return searchProviderSongsWithType(source, keyword, cookie, providerSearchTypeSong)
}

func searchProviderSongsWithType(source, keyword, cookie string, searchType int) ([]providermodel.Track, error) {
	client, err := getProviderBridgeClient()
	if err != nil {
		return nil, err
	}
	songs, err := client.Search(context.Background(), bridge.SearchRequest{
		Source: source, Keyword: keyword, Limit: providerSearchLimit(), Cookie: cookie,
		SearchType: searchType,
	})
	if err != nil {
		return nil, err
	}
	publicSongs := make([]providermodel.Track, 0, len(songs))
	for _, song := range songs {
		cacheProviderSong(song, cookie)
		publicSongs = append(publicSongs, publicProviderSong(song))
	}
	return publicSongs, nil
}

func resolveProviderSong(source string, song *providermodel.Track, cookie string) (providermodel.Track, error) {
	if song == nil {
		return providermodel.Track{}, errors.New("song is nil")
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
		return providermodel.Track{}, errors.New("missing provider lookup data")
	}

	client, err := getProviderBridgeClient()
	if err != nil {
		return providermodel.Track{}, err
	}
	candidates, err := client.Search(context.Background(), bridge.SearchRequest{
		Source: source, Keyword: keyword, Limit: providerSearchLimit(), Cookie: cookie,
	})
	if err != nil {
		return providermodel.Track{}, err
	}
	for _, candidate := range candidates {
		cacheProviderSong(candidate, cookie)
		if strings.TrimSpace(candidate.ID) == strings.TrimSpace(song.ID) {
			return candidate, nil
		}
	}
	if len(candidates) == 0 {
		return providermodel.Track{}, errors.New("provider returned no matching songs")
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
		return providermodel.Track{}, errors.New("provider returned no matching song identity")
	}
	return candidates[bestIndex], nil
}

func providerDownloadURL(source string, song *providermodel.Track) (string, error) {
	media, err := ResolveProviderMedia(song)
	if err != nil {
		return "", err
	}
	return media.URL, nil
}

func ResolveProviderMedia(song *providermodel.Track) (ProviderMedia, error) {
	if song == nil {
		return ProviderMedia{}, errors.New("song is nil")
	}
	source := strings.TrimSpace(song.Source)
	if !providerBridgeSupports(source) {
		return ProviderMedia{}, fmt.Errorf("unsupported source: %s", source)
	}
	resolved, err := resolveProviderSong(source, song, cookieForSource(source))
	if err != nil {
		return ProviderMedia{}, err
	}
	urlStr := strings.TrimSpace(resolved.URL)
	if urlStr == "" || resolved.IsInvalid {
		return ProviderMedia{}, errors.New("provider returned an invalid download URL")
	}
	return ProviderMedia{URL: urlStr, PlayAuth: strings.TrimSpace(resolved.Extra["play_auth"])}, nil
}

func providerLyrics(source string, song *providermodel.Track) (string, error) {
	// Search responses already contain the provider lyric when the sidecar was
	// able to fetch it. Reuse that payload instead of re-running a full provider
	// search for an otherwise identical track.
	if song != nil {
		if lyric := strings.TrimSpace(song.Extra["lyric"]); lyric != "" {
			return lyric, nil
		}
	}
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

func verifyProviderAccount(source, cookie string) (bool, error) {
	client, err := getProviderBridgeClient()
	if err != nil {
		return false, err
	}
	return client.VerifyAccount(context.Background(), bridge.AccountVerifyRequest{
		Source: strings.TrimSpace(source), Cookie: strings.TrimSpace(cookie),
	})
}

func cacheProviderSong(song providermodel.Track, cookie string) {
	song.Source = strings.TrimSpace(song.Source)
	song.ID = strings.TrimSpace(song.ID)
	if song.Source == "" || song.ID == "" {
		return
	}
	entry := providerSongCacheEntry{song: cloneProviderSong(song), expiresAt: time.Now().Add(providerSongCacheTTL)}
	providerSongCache.Store(providerSongCacheKey(song.Source, song.ID, cookie), entry)
	cacheProviderHeaders(song)
}

func loadProviderSong(source, id, cookie string) (providermodel.Track, bool) {
	key := providerSongCacheKey(source, id, cookie)
	raw, ok := providerSongCache.Load(key)
	if !ok {
		return providermodel.Track{}, false
	}
	entry, ok := raw.(providerSongCacheEntry)
	if !ok || time.Now().After(entry.expiresAt) {
		providerSongCache.Delete(key)
		return providermodel.Track{}, false
	}
	return cloneProviderSong(entry.song), true
}

func providerSongCacheKey(source, id, cookie string) string {
	digest := sha1.Sum([]byte(strings.TrimSpace(cookie)))
	return strings.TrimSpace(source) + "\x00" + strings.TrimSpace(id) + "\x00" + hex.EncodeToString(digest[:])
}

func publicProviderSong(song providermodel.Track) providermodel.Track {
	extra := cloneStringMap(song.Extra)
	delete(extra, "download_headers")
	delete(extra, "play_auth")
	if extra == nil {
		extra = make(map[string]string)
	}
	lookup := strings.TrimSpace(strings.Join([]string{song.Name, song.Artist}, " "))
	if lookup != "" {
		extra["provider_lookup"] = lookup
	}
	return providermodel.Track{
		ID: song.ID, Name: song.Name, Artist: song.Artist, Album: song.Album,
		AlbumID: song.AlbumID, Duration: song.Duration, Size: song.Size,
		Bitrate: song.Bitrate, Source: song.Source, Ext: song.Ext,
		Cover: song.Cover, Link: song.Link, Extra: extra,
		IsInvalid: song.IsInvalid, IsVIP: song.IsVIP,
	}
}

func cloneProviderSong(song providermodel.Track) providermodel.Track {
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

func cacheProviderHeaders(song providermodel.Track) {
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

package core

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
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

	// providerResolveLimitDefault 是"只为解析某一首歌的播放地址"时该请求的候选数。
	//
	// 为什么不能复用 providerSearchLimit: 这两条路径的语义完全不同。
	//   - 搜索列表: 用户要看到候选, 20 首是产品要求, 多探一首就多一首可播的。
	//   - 取址(播放/下载): 只要**那一首**。传 20 会让 sidecar 给 20 首各跑一遍
	//     vkey + 音质阶梯探活, 然后把 19 首的结果丢掉。
	//
	// 2026-11 实测(生产真日志, 同一台 NAS, 同一条 QQ 链路):
	//   limit=1  0.61s / limit=20 0.64s(无凭证时侧活几乎全失败, 差别不明显);
	//   但**有凭证时**探活要对每首真的发 Range 请求, 20 首才凑齐一次完整阶梯,
	//   歌单里未命中缓存的歌每次切歌都重走一遍 —— 实测 "/music/download?stream=1"
	//   耗时 1.48s / 2.90s / 3.47s / **10.94s**, 全部花在解析地址上。
	//
	// 仍然给到 3 是因为"按歌名+歌手搜, 目标曲可能不在第 1 名"(译名/翻唱/多版本),
	// 与 resolveProviderSong 里按 ID 命中 + 相似度兜底的逻辑配套; 再大就只是白打上游。
	providerResolveLimitEnv     = "MUSIC_DL_PROVIDER_RESOLVE_LIMIT"
	providerResolveLimitDefault = 3
	providerResolveLimitMax     = 20
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

// providerResolveLimit 返回"只为取一首歌的播放地址"时应请求的候选数。
//
// 与 providerSearchLimit 分开, 见 providerResolveLimitDefault 的注释:
// 取址只需要目标那一首, 传搜索页的 20 会让 sidecar 白跑 19 首的 vkey + 探活。
func providerResolveLimit() int {
	limit := intEnv(providerResolveLimitEnv, providerResolveLimitDefault)
	if limit > providerResolveLimitMax {
		return providerResolveLimitMax
	}
	if limit < 1 {
		return 1
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
	result, err := client.SearchWithRefresh(context.Background(), bridge.SearchRequest{
		Source: source, Keyword: keyword, Limit: providerSearchLimit(), Cookie: cookie,
		SearchType: searchType,
	})
	if err != nil {
		return nil, normalizeProviderSearchError(err)
	}
	songs := result.Songs
	// sidecar 自动续期了该源 cookie(QQ musickey 3 天到期): 立刻落库, 否则下次请求又用旧的。
	persistRefreshedCookie(source, cookie, result.RefreshedCookie)
	publicSongs := make([]providermodel.Track, 0, len(songs))
	for _, song := range songs {
		cacheProviderSong(song, cookie)
		publicSongs = append(publicSongs, publicProviderSong(song))
	}
	return publicSongs, nil
}

// persistRefreshedCookie 把 sidecar 自动续期后的 cookie 写回配置库。
//
// 只有确实变了才写(避免每次搜索都触发一次 DB 事务)。续期只在 musickey 过期时发生,
// 所以正常情况下这里绝大多数调用都会因为 old == refreshed 直接返回。
func persistRefreshedCookie(source, oldCookie, refreshedCookie string) {
	refreshedCookie = strings.TrimSpace(refreshedCookie)
	if refreshedCookie == "" || refreshedCookie == strings.TrimSpace(oldCookie) {
		return
	}
	key := canonicalCookieSource(source)
	CM.SetAll(map[string]string{key: refreshedCookie})
	CM.Save()
	log.Printf("[provider] %s 凭证已自动续期并持久化(用户无需重新扫码)", key)
}

func resolveProviderSong(source string, song *providermodel.Track, cookie string) (providermodel.Track, error) {
	if song == nil {
		return providermodel.Track{}, errors.New("song is nil")
	}
	if cached, ok := loadProviderSong(source, song.ID, cookie); ok {
		return cached, nil
	}

	// 绝不能把歌曲 ID 当成搜索关键词。
	//
	// 历史坑(2026-11 真实事故): 这里原先有一行 `keyword = song.ID` 兜底。对网易这种
	// 纯数字 ID 的源, 那等于拿一串数字去搜歌名 —— 既永远搜不到目标曲(白白消耗一次
	// 上游搜索), 又会在歌单预热时被放大成"每首缺 provider_lookup 的歌打一次搜索"。
	// 实测: 打开几个歌单后连续发出 79 次纯数字关键词的网易搜索, 直接把网易打成
	// code=405 全域限流, 之后连「腐草为萤」这种正常歌曲的播放都 502。
	// 对 QQ 这种 songmid(ID 是字母数字串)同样搜不到东西, 只是不会触发限流。
	keyword := ProviderLookupKeyword(song)
	if keyword == "" {
		return providermodel.Track{}, errors.New("missing provider lookup data")
	}

	// 两段式取址: 先试探性地少取几首, 命中目标 ID 就走; 没命中再按搜索页的候选数
	// 重跑一遍完整逻辑。
	//
	// 为什么要这样而不是直接把候选数调小(2026-11):
	// 降候选数本身是安全的**前提**是"只拿它做快路径"。旧算法在 20 首里依次做两件事 ——
	// ① 精确 ID 命中即返回; ② 否则按相似度兜底(≥0.75)挑一个**同源但 ID 不同**的版本。
	// 如果只是把 20 改成 3, 第 ② 步的搜索池也被一起砍掉: 目标 ID 不在前 3 时会退化成
	// "在前 3 名里挑个像的", 于是可能播成同名的 live/翻唱版本、或歌词拿到别人的 —— 这是
	// 静默的行为回归, 不会报错但用户听到的是错的歌。
	// 现在快路径**只接受精确 ID 命中**(matchByID), 一旦不是精确命中就升级到完整候选数
	// 重跑, 因此最终返回值与改动前逐字等价; 命中率高的常见情形(歌单里播已搜过的歌)
	// 则省掉了 17 首歌各跑一遍 vkey + 音质阶梯探活的开销。
	fastLimit, fullLimit := providerResolveLimit(), providerSearchLimit()
	if fastLimit < fullLimit {
		resolved, matchedByID, err := resolveProviderSongOnce(source, song, keyword, cookie, fastLimit)
		if err != nil {
			return providermodel.Track{}, err
		}
		if matchedByID {
			return resolved, nil
		}
	}
	return resolveProviderSongOnceFull(source, song, keyword, cookie, fullLimit)
}

// resolveProviderSongOnceFull 用完整候选数跑取址, 返回兜底结果。
func resolveProviderSongOnceFull(source string, song *providermodel.Track, keyword, cookie string, limit int) (providermodel.Track, error) {
	resolved, _, err := resolveProviderSongOnce(source, song, keyword, cookie, limit)
	return resolved, err
}

// resolveProviderSongOnce 按 limit 取一次候选并解析。
//
// matchedByID=true 表示"目标 ID 就在这批候选里", 此时 resolved 必定是目标曲本身;
// 为 false 时 resolved 是相似度兜底的结果(可能与目标曲不是同一个 ID, 与旧算法一致)。
func resolveProviderSongOnce(source string, song *providermodel.Track, keyword, cookie string, limit int) (resolved providermodel.Track, matchedByID bool, err error) {
	client, err := getProviderBridgeClient()
	if err != nil {
		return providermodel.Track{}, false, err
	}
	result, err := client.SearchWithRefresh(context.Background(), bridge.SearchRequest{
		Source: source, Keyword: keyword, Limit: limit, Cookie: cookie,
	})
	if err != nil {
		return providermodel.Track{}, false, normalizeProviderSearchError(err)
	}
	persistRefreshedCookie(source, cookie, result.RefreshedCookie)
	candidates := result.Songs
	for _, candidate := range candidates {
		cacheProviderSong(candidate, cookie)
		if strings.TrimSpace(candidate.ID) == strings.TrimSpace(song.ID) {
			return candidate, true, nil
		}
	}
	if len(candidates) == 0 {
		// 空的含义有三种, 必须区分 —— 否则会像 2026-10 那次事故一样,
		// 把"上游限流, 等一会儿就好"误导成"这首歌已下架, 换一首"。
		switch strings.TrimSpace(result.EmptyReason) {
		case "rate_limited":
			return providermodel.Track{}, false, ErrProviderRateLimited
		case "paid_or_unavailable":
			return providermodel.Track{}, false, ErrProviderPaidOnly
		default:
			return providermodel.Track{}, false, errors.New("provider returned no matching songs")
		}
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
		// 候选里没有这个 id, 也说明"这首拿不到地址"(付费曲/版权受限),
		// 而不是"网络抖了"。
		return providermodel.Track{}, false, ErrProviderPaidOnly
	}
	return candidates[bestIndex], false, nil
}

// 播放链路的两种"重试无用但原因不同"的错误, 供 internal/web 分类提示。
var (
	// ErrProviderRateLimited: 上游限流(QQ code=2001)。稍等重试可能就好。
	ErrProviderRateLimited = errors.New("provider rate limited the search")
	// ErrProviderPaidOnly: 有候选但拿不到下载地址(付费曲/版权受限)。重试无用。
	ErrProviderPaidOnly = errors.New("provider has no downloadable url for this song")
)

// IsProviderRateLimited / IsProviderPaidOnly 供上层(web 层)判断错误类型,
// 避免上层去匹配错误字符串。
func IsProviderRateLimited(err error) bool { return errors.Is(err, ErrProviderRateLimited) }
func IsProviderPaidOnly(err error) bool   { return errors.Is(err, ErrProviderPaidOnly) }

// normalizeProviderSearchError 把 sidecar 报上来的"被上游限流"归一化成哨兵错误。
//
// 为什么必须在这一层做: sidecar 的 /v1/search 在限流时返回非 2xx + {"error": "..."},
// 而 Client 只会把它变成一个**普通 error**。上层(internal/web)拿到的就是一句
// "netease search rate limited: 网易搜索被限流: 操作频繁，请稍候再试" —— 它
// errors.Is 匹配不到任何哨兵, 于是掉进兜底分支, 用户看到含糊的「音频源暂时不可用」。
//
// 2026-11 真实事故:「腐草为萤」播放 502, 界面长期只显示"音频源暂时不可用", 而真因
// 是网易 code=405 限流(等一会儿就好)。这次把判定收敛到 core 这一处, 上层不再按文案猜。
// ProviderLookupKeyword 返回取址时可用的搜索词; 空串表示"没有可用信息"。
//
// 规则只有一处实现, 因为**取址**和**预热前的准入判断**必须用同一套口径 ——
// 两边口径不一致时, 预热会放进去一批取址必然失败的曲目, 每个都白打一次上游。
//
// 绝不能退回 song.ID(见 resolveProviderSong 上的事故注释): 拿歌曲 ID 当关键词搜,
// 网易上连发几十次就打成了 code=405 全域限流。
func ProviderLookupKeyword(song *providermodel.Track) string {
	if song == nil {
		return ""
	}
	keyword := strings.TrimSpace(song.Extra["provider_lookup"])
	if keyword == "" {
		keyword = strings.TrimSpace(strings.Join([]string{song.Name, song.Artist}, " "))
	}
	// 判断"关键词是否就是 ID 本身"比判断"是不是纯数字"更稳: 两边的 ID 拿来搜都是错。
	if keyword == "" || keyword == strings.TrimSpace(song.ID) {
		return ""
	}
	return keyword
}

func normalizeProviderSearchError(err error) error {	if err == nil || IsProviderRateLimited(err) || IsProviderPaidOnly(err) {
		return err
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "rate limited") || strings.Contains(message, "rate_limited") {
		// 保留原始信息便于日志排查, 同时保证 errors.Is 能命中哨兵。
		return fmt.Errorf("%w: %v", ErrProviderRateLimited, err)
	}
	return err
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
	// able to fetch it. Reuse that payload instead of replacing richer verbatim
	// lyrics with a second, line-level request.
	if song != nil {
		if lyric := strings.TrimSpace(song.Extra["lyric"]); lyric != "" {
			return lyric, nil
		}
	}
	// 原生网易快速搜索不为每个候选额外取歌词，因此搜索缓存里可能没有
	// extra.lyric。播放页按歌曲 ID 按需补取，不能把“缓存无 lyric”当成无歌词。
	if song != nil && strings.EqualFold(strings.TrimSpace(source), "netease") {
		if client, err := getProviderBridgeClient(); err == nil {
			if lyric, lyricErr := client.Lyric(context.Background(), bridge.LyricRequest{
				Source: source,
				ID:     song.ID,
				Cookie: cookieForSource(source),
			}); lyricErr == nil && strings.TrimSpace(lyric) != "" {
				return strings.TrimSpace(lyric), nil
			}
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

// CookieForSource 返回某源已保存的平台 cookie(空串表示未登录)。
//
// 导出它是因为 internal/web 需要用同一份凭证去请求"按身份补数据"的接口(如副歌点位),
// 而 cookie 的规范化规则(qq_wx -> qq)必须只有一处实现, 不能让 web 层自己再拼一遍。
func CookieForSource(source string) string {
	return cookieForSource(source)
}

// NewProviderBridgeClient 返回 Provider sidecar 的客户端。
//
// 与 getProviderBridgeClient 的区别仅在可见性: 前者供 internal/web 发起
// 不与搜索链路耦合的独立请求(如副歌点位批量查询), 二者共享连接与缓存配置。
func NewProviderBridgeClient() (*bridge.Client, error) {
	return getProviderBridgeClient()
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

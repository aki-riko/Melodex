package core

import (
	"context"
	"net/url"
	"slices"
	"strings"

	"github.com/aki-riko/Melodex/backend/internal/provider/bridge"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

type SearchFunc func(keyword string) ([]model.Track, error)
type SearchPlaylistFunc func(keyword string) ([]model.RemoteCollection, error)
type PlaylistCategoriesFunc func() ([]model.RemoteCategory, error)
type CategoryPlaylistsFunc func(string, int, int) ([]model.RemoteCollection, error)
type QRLoginCreateFunc func() (*model.LoginChallenge, error)
type QRLoginCheckFunc func(string) (*model.LoginResult, error)
type UserPlaylistsFunc func(page, limit int) ([]model.RemoteCollection, error)

var (
	allProviderNames        = []string{"netease", "qq", "kugou", "kuwo", "migu", "fivesing", "jamendo", "joox", "qianqian", "soda", "bilibili", "apple"}
	collectionProviderNames = []string{"netease", "qq", "kugou", "kuwo", "migu"}
	// defaultProviderNames 是歌曲搜索默认扇出的源。apple 已从中摘除(2026-09):
	// 实测其上游已变(快照正则写死旧 JWT 头 (?=eyJh), Apple 改发 eyJ0 开头), 每次搜索
	// 必然 502、恒返回 0 首, 白占一个扇出槽位; 即便在 bridge 层修好 token 获取, 没有
	// Apple Music 登录态(media-user-token)时拿到的也只是 AudioPrev 试听片段, 会让搜索结果
	// 混入"验活能过、实际只有试听"的假候选。仍保留在 allProviderNames/bridge 白名单里,
	// 需要时(如拿到 Apple 会员登录态)可显式指定 sources=apple 重新启用。
	defaultProviderNames    = []string{"netease", "qq", "kugou", "kuwo", "migu", "qianqian", "soda"}
	recommendProviderNames  = []string{"netease", "qq", "kugou", "kuwo"}
	userLibrarySourceNames  = []string{"netease", "qq"}
	cookieSourceNames       = []string{"netease", "qq", "qq_wx", "kugou", "kuwo", "migu", "bilibili", "soda"}
	providerDescriptions    = map[string]string{
		"apple": "Apple Music", "bilibili": "Bilibili", "fivesing": "5sing",
		"jamendo": "Jamendo (CC)", "joox": "JOOX", "kugou": "酷狗音乐",
		"kuwo": "酷我音乐", "migu": "咪咕音乐", "netease": "网易云音乐",
		"qianqian": "千千音乐", "qq": "QQ音乐", "soda": "汽水音乐",
	}
)

func collectionProviderSupports(source string) bool {
	source = strings.TrimSpace(source)
	return slices.Contains(collectionProviderNames, source)
}

func providerCollections(source string, request bridge.CollectionRequest) (bridge.CollectionResponse, error) {
	client, err := getProviderBridgeClient()
	if err != nil {
		return bridge.CollectionResponse{}, err
	}
	request.Source = strings.TrimSpace(source)
	request.Cookie = cookieForSource(source)
	return client.Collections(context.Background(), request)
}

func GetSearchFunc(source string) SearchFunc {
	source = strings.TrimSpace(source)
	if !providerBridgeSupports(source) {
		return nil
	}
	return func(keyword string) ([]model.Track, error) {
		return searchProviderSongs(source, keyword, cookieForSource(source))
	}
}

func GetLyricSearchFunc(source string) SearchFunc {
	source = strings.TrimSpace(source)
	// 歌词搜索原本只走 qq,因其搜歌接口原生支持按歌词片段检索(search_type=7);当时快照
	// 客户端在有无凭据下都返回 0 首且耗时 215s,整条链路失效,才临时扩到 netease/kuwo/migu
	// 只按标题/歌手兜底。QQ 现由 Melodex 自有实现接管(provider_bridge/qq_source.py),
	// 实测 search_type=7 对歌词片段精准命中(「故事的小黄花」→ 晴天/周杰伦、
	// 「天青色等烟雨」→ 青花瓷/周杰伦),因此恢复走原生片段检索,其余源作为补充。
	//
	// 网易同样恢复了**真**歌词检索(provider_bridge/netease_source.py): 走网易自己的
	// /api/search/get/web type=1006, 匿名即可命中(实测「都 是勇敢的」→ 孤勇者/陈奕迅原唱
	// 第 1 名), 带管理员网易 cookie 时付费曲也能拿到地址(实测 52MB/1676k flac), 全程 ~1s。
	// 这一点很重要: QQ 的会员凭证一旦失效, 歌词片段搜索本来会整体不可用, 网易这一路能兜住。
	// kuwo/migu 仍按标题/歌手兜底(快照没有歌词检索能力)。
	switch source {
	case "qq":
		return func(keyword string) ([]model.Track, error) {
			return searchProviderSongsWithType(source, keyword, cookieForSource(source), providerSearchTypeLyric)
		}
	case "netease":
		return func(keyword string) ([]model.Track, error) {
			return searchProviderSongsWithType(source, keyword, cookieForSource(source), providerSearchTypeLyric)
		}
	case "kuwo", "migu":
		return GetSearchFunc(source)
	default:
		return nil
	}
}

func GetAlbumSearchFunc(source string) SearchPlaylistFunc {
	if !collectionProviderSupports(source) {
		return nil
	}
	return func(keyword string) ([]model.RemoteCollection, error) {
		response, err := providerCollections(source, bridge.CollectionRequest{Action: "search_album", Keyword: keyword})
		return response.Collections, err
	}
}

func GetPlaylistSearchFunc(source string) SearchPlaylistFunc {
	if !collectionProviderSupports(source) {
		return nil
	}
	return func(keyword string) ([]model.RemoteCollection, error) {
		response, err := providerCollections(source, bridge.CollectionRequest{Action: "search_playlist", Keyword: keyword})
		return response.Collections, err
	}
}

func GetAlbumDetailFunc(source string) func(string) ([]model.Track, error) {
	if !collectionProviderSupports(source) {
		return nil
	}
	return func(id string) ([]model.Track, error) {
		response, err := providerCollections(source, bridge.CollectionRequest{Action: "album", ID: id})
		return response.Songs, err
	}
}

func GetPlaylistDetailFunc(source string) func(string) ([]model.Track, error) {
	if !collectionProviderSupports(source) {
		return nil
	}
	return func(id string) ([]model.Track, error) {
		response, err := providerCollections(source, bridge.CollectionRequest{Action: "playlist", ID: id})
		return response.Songs, err
	}
}

func GetRecommendFunc(source string) func() ([]model.RemoteCollection, error) {
	source = strings.TrimSpace(source)
	if !slices.Contains(recommendProviderNames, source) {
		return nil
	}
	return func() ([]model.RemoteCollection, error) {
		response, err := providerCollections(source, bridge.CollectionRequest{Action: "recommend"})
		return response.Collections, err
	}
}

func GetPlaylistCategoriesFunc(source string) PlaylistCategoriesFunc {
	if !collectionProviderSupports(source) {
		return nil
	}
	return func() ([]model.RemoteCategory, error) {
		response, err := providerCollections(source, bridge.CollectionRequest{Action: "categories"})
		return response.Categories, err
	}
}

func GetCategoryPlaylistsFunc(source string) CategoryPlaylistsFunc {
	if !collectionProviderSupports(source) {
		return nil
	}
	return func(categoryID string, page, limit int) ([]model.RemoteCollection, error) {
		response, err := providerCollections(source, bridge.CollectionRequest{
			Action: "category", CategoryID: categoryID, Page: page, Limit: limit,
		})
		return response.Collections, err
	}
}

func GetQRLoginCreateFunc(source string) QRLoginCreateFunc {
	if strings.TrimSpace(source) != "netease" {
		return nil
	}
	return func() (*model.LoginChallenge, error) {
		client, err := getProviderBridgeClient()
		if err != nil {
			return nil, err
		}
		return client.QRCreate(context.Background(), bridge.QRCreateRequest{Source: source})
	}
}

func GetQRLoginCheckFunc(source string) QRLoginCheckFunc {
	if strings.TrimSpace(source) != "netease" {
		return nil
	}
	return func(key string) (*model.LoginResult, error) {
		client, err := getProviderBridgeClient()
		if err != nil {
			return nil, err
		}
		return client.QRCheck(context.Background(), bridge.QRCheckRequest{Source: source, Key: key})
	}
}

func GetQRLoginSourceNames() []string { return []string{"netease"} }
func GetCookieSourceNames() []string  { return slices.Clone(cookieSourceNames) }

func GetUserPlaylistsFunc(source string) UserPlaylistsFunc {
	source = strings.TrimSpace(source)
	if !slices.Contains(userLibrarySourceNames, source) {
		return nil
	}
	return func(page, limit int) ([]model.RemoteCollection, error) {
		response, err := providerCollections(source, bridge.CollectionRequest{Action: "user_playlists", Page: page, Limit: limit})
		return response.Collections, err
	}
}

func GetUserPlaylistSourceNames() []string { return slices.Clone(userLibrarySourceNames) }
func GetRecommendSourceNames() []string    { return slices.Clone(recommendProviderNames) }

func GetDownloadFunc(source string) func(*model.Track) (string, error) {
	source = strings.TrimSpace(source)
	if !providerBridgeSupports(source) {
		return nil
	}
	return func(track *model.Track) (string, error) { return providerDownloadURL(source, track) }
}

func GetLyricFunc(source string) func(*model.Track) (string, error) {
	source = strings.TrimSpace(source)
	if !providerBridgeSupports(source) {
		return nil
	}
	return func(track *model.Track) (string, error) { return providerLyrics(source, track) }
}

func GetParseFunc(string) func(string) (*model.Track, error) { return nil }

func GetParsePlaylistFunc(source string) func(string) (*model.RemoteCollection, []model.Track, error) {
	if !collectionProviderSupports(source) {
		return nil
	}
	return func(link string) (*model.RemoteCollection, []model.Track, error) {
		response, err := providerCollections(source, bridge.CollectionRequest{Action: "parse_playlist", Link: link})
		return response.Collection, response.Songs, err
	}
}

func GetParseAlbumFunc(source string) func(string) (*model.RemoteCollection, []model.Track, error) {
	if !collectionProviderSupports(source) {
		return nil
	}
	return func(link string) (*model.RemoteCollection, []model.Track, error) {
		response, err := providerCollections(source, bridge.CollectionRequest{Action: "parse_album", Link: link})
		return response.Collection, response.Songs, err
	}
}

func GetAllSourceNames() []string              { return slices.Clone(allProviderNames) }
func GetPlaylistSourceNames() []string         { return slices.Clone(collectionProviderNames) }
func GetAlbumSourceNames() []string            { return slices.Clone(collectionProviderNames) }
func GetPlaylistCategorySourceNames() []string { return slices.Clone(collectionProviderNames) }
func GetDefaultSourceNames() []string          { return slices.Clone(defaultProviderNames) }
func GetLyricSearchSourceNames() []string {
	// qq 原生支持按歌词片段检索,放首位;其余源不匹配歌词内容,只按标题/歌手兜底。
	return []string{"qq", "netease", "kuwo", "migu"}
}

func GetSourceDescription(source string) string {
	if description := providerDescriptions[strings.TrimSpace(source)]; description != "" {
		return description
	}
	return "未知音乐源"
}

type providerDomainRule struct {
	provider string
	domains  []string
}

var providerDomainRules = []providerDomainRule{
	{provider: "netease", domains: []string{"163.com"}},
	{provider: "qq", domains: []string{"qq.com"}},
	{provider: "fivesing", domains: []string{"5sing.com"}},
	{provider: "kugou", domains: []string{"kugou.com"}},
	{provider: "kuwo", domains: []string{"kuwo.cn"}},
	{provider: "migu", domains: []string{"migu.cn"}},
	{provider: "joox", domains: []string{"joox.com"}},
	{provider: "bilibili", domains: []string{"bilibili.com", "b23.tv"}},
	{provider: "soda", domains: []string{"douyin.com", "qishui.com"}},
	{provider: "qianqian", domains: []string{"91q.com"}},
	{provider: "jamendo", domains: []string{"jamendo.com"}},
	{provider: "apple", domains: []string{"music.apple.com", "itunes.apple.com"}},
}

func DetectSource(link string) string {
	host := sourceLinkHostname(link)
	for _, rule := range providerDomainRules {
		for _, domain := range rule.domains {
			if host == domain || strings.HasSuffix(host, "."+domain) {
				return rule.provider
			}
		}
	}
	return ""
}

func sourceLinkHostname(link string) string {
	link = strings.TrimSpace(link)
	if link == "" {
		return ""
	}
	if !strings.Contains(link, "://") {
		link = "https://" + strings.TrimPrefix(link, "//")
	}
	parsed, err := url.Parse(link)
	if err != nil {
		return ""
	}
	return strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
}

var originalLinkPatterns = map[string]map[string]string{
	"netease":  {"album": "https://music.163.com/#/album?id=%s", "playlist": "https://music.163.com/#/playlist?id=%s", "song": "https://music.163.com/#/song?id=%s"},
	"qq":       {"album": "https://y.qq.com/n/ryqq/albumDetail/%s", "playlist": "https://y.qq.com/n/ryqq/playlist/%s", "song": "https://y.qq.com/n/ryqq/songDetail/%s"},
	"kugou":    {"album": "https://www.kugou.com/album/%s.html", "playlist": "https://www.kugou.com/yy/special/single/%s.html", "song": "https://www.kugou.com/song/#hash=%s"},
	"kuwo":     {"album": "http://www.kuwo.cn/album_detail/%s", "playlist": "http://www.kuwo.cn/playlist_detail/%s", "song": "http://www.kuwo.cn/play_detail/%s"},
	"migu":     {"album": "https://music.migu.cn/v3/music/album/%s", "playlist": "https://music.migu.cn/v5/#/playlist?playlistId=%s&playlistType=ordinary", "song": "https://music.migu.cn/v3/music/song/%s"},
	"jamendo":  {"album": "https://www.jamendo.com/album/%s", "playlist": "https://www.jamendo.com/playlist/%s", "song": "https://www.jamendo.com/track/%s"},
	"joox":     {"album": "https://www.joox.com/hk/album/%s", "playlist": "https://www.joox.com/hk/playlist/%s", "song": "https://www.joox.com/hk/single/%s"},
	"qianqian": {"album": "https://music.91q.com/album/%s", "playlist": "https://music.91q.com/songlist/%s", "song": "https://music.91q.com/song/%s"},
	"soda":     {"album": "https://www.qishui.com/share/album?album_id=%s", "playlist": "https://www.qishui.com/playlist/%s"},
	"apple":    {"album": "https://music.apple.com/album/%s", "playlist": "https://music.apple.com/playlist/%s", "song": "https://music.apple.com/song/%s"},
}

func GetOriginalLink(source, id, contentType string) string {
	source = strings.TrimSpace(source)
	id = strings.TrimSpace(id)
	contentType = strings.TrimSpace(contentType)
	if source == "qq" && strings.HasPrefix(id, "profile:") {
		return "https://y.qq.com/n/ryqq/profile"
	}
	if source == "kugou" && contentType == "playlist" && strings.HasPrefix(id, "cloudlist:") {
		return ""
	}
	if source == "bilibili" {
		return "https://www.bilibili.com/video/" + id
	}
	if source == "fivesing" {
		if contentType == "playlist" {
			return "http://5sing.kugou.com/dj/" + id + ".html"
		}
		if strings.Contains(id, "/") {
			return "http://5sing.kugou.com/" + id + ".html"
		}
		return ""
	}
	patterns := originalLinkPatterns[source]
	pattern := patterns[contentType]
	if pattern == "" {
		return ""
	}
	return strings.Replace(pattern, "%s", id, 1)
}

package core

import (
	"net/url"
	"slices"
	"strings"

	"github.com/aki-riko/Melodex/backend/internal/provider/extensions"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

type SearchFunc func(keyword string) ([]model.Track, error)
type SearchPlaylistFunc func(keyword string) ([]model.RemoteCollection, error)
type PlaylistCategoriesFunc func() ([]model.RemoteCategory, error)
type CategoryPlaylistsFunc func(string, int, int) ([]model.RemoteCollection, error)
type QRLoginCreateFunc func() (*model.LoginChallenge, error)
type QRLoginCheckFunc func(string) (*model.LoginResult, error)
type UserPlaylistsFunc func(page, limit int) ([]model.RemoteCollection, error)

type collectionProvider interface {
	SearchAlbum(string) ([]model.RemoteCollection, error)
	SearchPlaylist(string) ([]model.RemoteCollection, error)
	GetAlbumSongs(string) ([]model.Track, error)
	GetPlaylistSongs(string) ([]model.Track, error)
	PlaylistCategories() ([]model.RemoteCategory, error)
	CategoryPlaylists(string, int, int) ([]model.RemoteCollection, error)
	ParseAlbum(string) (*model.RemoteCollection, []model.Track, error)
	ParsePlaylist(string) (*model.RemoteCollection, []model.Track, error)
}

type recommendationProvider interface {
	RecommendedPlaylists() ([]model.RemoteCollection, error)
}

type userLibraryProvider interface {
	UserPlaylists(int, int) ([]model.RemoteCollection, error)
}

var collectionProviderFactories = map[string]func(string) collectionProvider{
	"netease": func(cookie string) collectionProvider { return extensions.NewNetease(cookie) },
	"qq":      func(cookie string) collectionProvider { return extensions.NewQQ(cookie) },
	"kugou":   func(cookie string) collectionProvider { return extensions.NewKugou(cookie) },
	"kuwo":    func(cookie string) collectionProvider { return extensions.NewKuwo(cookie) },
	"migu":    func(cookie string) collectionProvider { return extensions.NewMigu(cookie) },
}

var (
	allProviderNames        = []string{"netease", "qq", "kugou", "kuwo", "migu", "fivesing", "jamendo", "joox", "qianqian", "soda", "bilibili", "apple"}
	collectionProviderNames = []string{"netease", "qq", "kugou", "kuwo", "migu"}
	defaultProviderNames    = []string{"netease", "qq", "kugou", "kuwo", "migu", "qianqian", "soda", "apple"}
	recommendProviderNames  = []string{"netease", "qq", "kugou", "kuwo"}
	userLibrarySourceNames  = []string{"netease", "qq"}
	cookieSourceNames       = []string{"netease", "qq", "qq_wx", "kugou", "kuwo", "migu", "bilibili", "soda"}
	providerDescriptions    = map[string]string{
		"netease": "网易云音乐", "qq": "QQ音乐", "kugou": "酷狗音乐", "kuwo": "酷我音乐",
		"migu": "咪咕音乐", "fivesing": "5sing", "jamendo": "Jamendo (CC)", "joox": "JOOX",
		"qianqian": "千千音乐", "soda": "汽水音乐", "bilibili": "Bilibili", "apple": "Apple Music",
	}
)

func collectionProviderFor(source string) collectionProvider {
	factory := collectionProviderFactories[strings.TrimSpace(source)]
	if factory == nil {
		return nil
	}
	return factory(cookieForSource(source))
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
	if strings.TrimSpace(source) != "qq" {
		return nil
	}
	return GetSearchFunc("qq")
}

func GetAlbumSearchFunc(source string) SearchPlaylistFunc {
	if provider := collectionProviderFor(source); provider != nil {
		return provider.SearchAlbum
	}
	return nil
}

func GetPlaylistSearchFunc(source string) SearchPlaylistFunc {
	if provider := collectionProviderFor(source); provider != nil {
		return provider.SearchPlaylist
	}
	return nil
}

func GetAlbumDetailFunc(source string) func(string) ([]model.Track, error) {
	if provider := collectionProviderFor(source); provider != nil {
		return provider.GetAlbumSongs
	}
	return nil
}

func GetPlaylistDetailFunc(source string) func(string) ([]model.Track, error) {
	if provider := collectionProviderFor(source); provider != nil {
		return provider.GetPlaylistSongs
	}
	return nil
}

func GetRecommendFunc(source string) func() ([]model.RemoteCollection, error) {
	provider := collectionProviderFor(source)
	if recommender, ok := provider.(recommendationProvider); ok {
		return recommender.RecommendedPlaylists
	}
	return nil
}

func GetPlaylistCategoriesFunc(source string) PlaylistCategoriesFunc {
	if provider := collectionProviderFor(source); provider != nil {
		return provider.PlaylistCategories
	}
	return nil
}

func GetCategoryPlaylistsFunc(source string) CategoryPlaylistsFunc {
	if provider := collectionProviderFor(source); provider != nil {
		return provider.CategoryPlaylists
	}
	return nil
}

func GetQRLoginCreateFunc(source string) QRLoginCreateFunc {
	if strings.TrimSpace(source) == "netease" {
		return extensions.NeteaseCreateQRLogin
	}
	return nil
}

func GetQRLoginCheckFunc(source string) QRLoginCheckFunc {
	if strings.TrimSpace(source) == "netease" {
		return extensions.NeteaseCheckQRLogin
	}
	return nil
}

func GetQRLoginSourceNames() []string { return []string{"netease"} }
func GetCookieSourceNames() []string  { return slices.Clone(cookieSourceNames) }

func GetUserPlaylistsFunc(source string) UserPlaylistsFunc {
	provider := collectionProviderFor(source)
	if library, ok := provider.(userLibraryProvider); ok {
		return library.UserPlaylists
	}
	return nil
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
	if provider := collectionProviderFor(source); provider != nil {
		return provider.ParsePlaylist
	}
	return nil
}

func GetParseAlbumFunc(source string) func(string) (*model.RemoteCollection, []model.Track, error) {
	if provider := collectionProviderFor(source); provider != nil {
		return provider.ParseAlbum
	}
	return nil
}

func GetAllSourceNames() []string              { return slices.Clone(allProviderNames) }
func GetPlaylistSourceNames() []string         { return slices.Clone(collectionProviderNames) }
func GetAlbumSourceNames() []string            { return slices.Clone(collectionProviderNames) }
func GetPlaylistCategorySourceNames() []string { return slices.Clone(collectionProviderNames) }
func GetDefaultSourceNames() []string          { return slices.Clone(defaultProviderNames) }
func GetLyricSearchSourceNames() []string      { return []string{"qq"} }

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

package extensions

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/guohuiyuan/go-music-dl/internal/provider/model"
)

const (
	kuwoSearchBaseURL = "http://search.kuwo.cn/r.s"
	kuwoListBaseURL   = "http://nplserver.kuwo.cn/pl.svc"
	kuwoBrowseBaseURL = "http://wapi.kuwo.cn/api/pc/classify/playlist"
)

var (
	kuwoPlaylistLinkPattern = regexp.MustCompile(`(?i)/playlist_detail/(\d+)`)
	kuwoAlbumLinkPattern    = regexp.MustCompile(`(?i)/album_detail/(\d+)`)
)

type Kuwo struct {
	Cookie string
}

func NewKuwo(cookie string) *Kuwo {
	return &Kuwo{Cookie: strings.TrimSpace(cookie)}
}

func (client *Kuwo) SearchPlaylist(keyword string) ([]model.Playlist, error) {
	payload, err := client.searchCollection(keyword, "playlist")
	if err != nil {
		return nil, err
	}
	return kuwoPlaylists(payload["abslist"]), nil
}

func (client *Kuwo) SearchAlbum(keyword string) ([]model.Playlist, error) {
	payload, err := client.searchCollection(keyword, "album")
	if err != nil {
		return nil, err
	}
	return kuwoAlbums(payload["albumlist"]), nil
}

func (client *Kuwo) searchCollection(keyword, collectionType string) (map[string]interface{}, error) {
	query := url.Values{
		"client": {"kt"}, "all": {strings.TrimSpace(keyword)}, "pn": {"0"}, "rn": {"30"},
		"uid": {"0"}, "ver": {"kwplayer_ar_9.2.2.1"}, "vipver": {"1"},
		"show_copyright_off": {"1"}, "newver": {"1"}, "ft": {collectionType},
		"cluster": {"0"}, "strategy": {"2012"}, "encoding": {"utf8"},
		"rformat": {"json"}, "mobi": {"1"},
	}
	return getSingleQuotedJSON(kuwoSearchBaseURL+"?"+query.Encode(), client.Cookie, nil)
}

func (client *Kuwo) GetPlaylistSongs(id string) ([]model.Song, error) {
	_, songs, err := client.Playlist(id)
	return songs, err
}

func (client *Kuwo) GetAlbumSongs(id string) ([]model.Song, error) {
	_, songs, err := client.Album(id)
	return songs, err
}

func (client *Kuwo) Playlist(id string) (*model.Playlist, []model.Song, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, nil, fmt.Errorf("kuwo playlist id is empty")
	}
	query := url.Values{
		"op": {"getlistinfo"}, "pid": {id}, "pn": {"0"}, "rn": {"1000"},
		"encode": {"utf8"}, "keyset": {"pl2012"}, "vipver": {"MUSIC_9.1.1.2_BCS2"}, "newver": {"1"},
	}
	payload, err := getJSON(kuwoListBaseURL+"?"+query.Encode(), client.Cookie, nil)
	if err != nil {
		return nil, nil, err
	}
	playlist := kuwoPlaylistDetail(payload, id)
	songs := kuwoSongs(payload["musiclist"], playlist)
	if len(songs) == 0 {
		return nil, nil, errorsForEmpty("kuwo playlist")
	}
	if playlist.TrackCount == 0 {
		playlist.TrackCount = len(songs)
	}
	return &playlist, songs, nil
}

func (client *Kuwo) Album(id string) (*model.Playlist, []model.Song, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, nil, fmt.Errorf("kuwo album id is empty")
	}
	endpoint := kuwoSearchBaseURL + "?pn=0&rn=1000&stype=albuminfo&albumid=" + url.QueryEscape(id) +
		"&sortby=0&alflac=1&show_copyright_off=1&pcmp4=1&encoding=utf8"
	payload, err := getSingleQuotedJSON(endpoint, client.Cookie, nil)
	if err != nil {
		return nil, nil, err
	}
	album := kuwoAlbum(payload)
	if album.ID == "" {
		album.ID = id
		album.Link = kuwoAlbumLink(id)
	}
	songs := kuwoSongs(payload["musiclist"], album)
	if len(songs) == 0 {
		return nil, nil, fmt.Errorf("kuwo album response has no songs: musiclist=%T songnum=%s", payload["musiclist"], text(payload["songnum"]))
	}
	if album.TrackCount == 0 {
		album.TrackCount = len(songs)
	}
	return &album, songs, nil
}

func (client *Kuwo) ParsePlaylist(link string) (*model.Playlist, []model.Song, error) {
	matches := kuwoPlaylistLinkPattern.FindStringSubmatch(strings.TrimSpace(link))
	if len(matches) != 2 {
		return nil, nil, fmt.Errorf("invalid kuwo playlist link")
	}
	return client.Playlist(matches[1])
}

func (client *Kuwo) ParseAlbum(link string) (*model.Playlist, []model.Song, error) {
	matches := kuwoAlbumLinkPattern.FindStringSubmatch(strings.TrimSpace(link))
	if len(matches) != 2 {
		return nil, nil, fmt.Errorf("invalid kuwo album link")
	}
	return client.Album(matches[1])
}

func (client *Kuwo) RecommendedPlaylists() ([]model.Playlist, error) {
	query := url.Values{
		"pn": {"1"}, "rn": {"30"}, "order": {"hot"},
		"loginUid": {"0"}, "loginSid": {"0"}, "appUid": {"38668888"},
	}
	payload, err := getJSON(kuwoBrowseBaseURL+"/getRcmPlayList?"+query.Encode(), client.Cookie, nil)
	if err != nil {
		return nil, err
	}
	if integer(payload["code"]) != 200 {
		return nil, fmt.Errorf("kuwo recommendations failed: code=%d message=%s", integer(payload["code"]), text(payload["msg"]))
	}
	playlists := kuwoBrowsePlaylists(at(payload, "data", "data"))
	if len(playlists) == 0 {
		return nil, errorsForEmpty("kuwo recommendations")
	}
	return playlists, nil
}

func (client *Kuwo) PlaylistCategories() ([]model.PlaylistCategory, error) {
	query := url.Values{"loginUid": {"0"}, "loginSid": {"0"}, "appUid": {"38668888"}}
	payload, err := getJSON(kuwoBrowseBaseURL+"/getTagList?"+query.Encode(), client.Cookie, nil)
	if err != nil {
		return nil, err
	}
	if integer(payload["code"]) != 200 {
		return nil, fmt.Errorf("kuwo playlist categories failed: code=%d message=%s", integer(payload["code"]), text(payload["msg"]))
	}
	result := []model.PlaylistCategory{{ID: "", Name: "全部", Group: "全部", Source: "kuwo"}}
	for _, groupValue := range array(payload["data"]) {
		group := object(groupValue)
		groupName := normalizeKuwoText(text(group["name"]))
		for _, itemValue := range array(group["data"]) {
			item := object(itemValue)
			id := text(item["id"])
			name := normalizeKuwoText(text(item["name"]))
			if id == "" || name == "" {
				continue
			}
			result = append(result, model.PlaylistCategory{
				ID: id, Name: name, Group: groupName, Source: "kuwo",
				Hot: strings.Contains(strings.ToUpper(text(item["extend"])), "HOT"),
			})
		}
	}
	return result, nil
}

func (client *Kuwo) CategoryPlaylists(categoryID string, page, limit int) ([]model.Playlist, error) {
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 30
	}
	query := url.Values{
		"pn": {strconv.Itoa(page)}, "rn": {strconv.Itoa(limit)},
		"loginUid": {"0"}, "loginSid": {"0"}, "appUid": {"38668888"},
	}
	endpoint := "/getRcmPlayList"
	if strings.TrimSpace(categoryID) == "" {
		query.Set("order", "hot")
	} else {
		endpoint = "/getTagPlayList"
		query.Set("id", strings.TrimSpace(categoryID))
	}
	payload, err := getJSON(kuwoBrowseBaseURL+endpoint+"?"+query.Encode(), client.Cookie, nil)
	if err != nil {
		return nil, err
	}
	if integer(payload["code"]) != 200 {
		return nil, fmt.Errorf("kuwo category playlists failed: code=%d message=%s", integer(payload["code"]), text(payload["msg"]))
	}
	playlists := kuwoBrowsePlaylists(at(payload, "data", "data"))
	if len(playlists) == 0 {
		return nil, errorsForEmpty("kuwo category playlists")
	}
	return playlists, nil
}

func kuwoSongs(value interface{}, collection model.Playlist) []model.Song {
	items := array(value)
	result := make([]model.Song, 0, len(items))
	for _, item := range items {
		raw := object(item)
		id := firstText(raw, "id", "musicrid", "audio_id")
		id = strings.TrimPrefix(id, "MUSIC_")
		if id == "" {
			continue
		}
		albumID := firstText(raw, "albumid", "albumId")
		if albumID == "" {
			albumID = collection.ID
		}
		album := normalizeKuwoText(firstText(raw, "album", "falbum"))
		if album == "" {
			album = collection.Name
		}
		cover := normalizeKuwoImageURL(firstText(raw, "albumpic", "pic120", "web_albumpic_short", "img"))
		if cover == "" {
			cover = collection.Cover
		}
		name := normalizeKuwoText(firstText(raw, "name", "songname", "fsongname"))
		artist := normalizeKuwoText(firstText(raw, "artist", "aartist", "fartist"))
		result = append(result, model.Song{
			ID: id, Name: name, Artist: artist, Album: album, AlbumID: albumID,
			Duration: integer(raw["duration"]), Source: "kuwo", Cover: cover,
			Link: "http://www.kuwo.cn/play_detail/" + id,
			Extra: map[string]string{
				"rid": id, "album_id": albumID, "provider_lookup": strings.TrimSpace(name + " " + artist),
			},
		})
	}
	return result
}

func kuwoPlaylists(value interface{}) []model.Playlist {
	items := array(value)
	result := make([]model.Playlist, 0, len(items))
	for _, item := range items {
		raw := object(item)
		id := text(raw["playlistid"])
		if id == "" {
			continue
		}
		result = append(result, model.Playlist{
			ID: id, Name: normalizeKuwoText(text(raw["name"])), Cover: normalizeKuwoImageURL(text(raw["pic"])),
			TrackCount: integer(raw["songnum"]), PlayCount: integer(raw["playcnt"]),
			Creator: normalizeKuwoText(text(raw["nickname"])), Description: normalizeKuwoText(text(raw["intro"])),
			Source: "kuwo", Link: kuwoPlaylistLink(id),
		})
	}
	return result
}

func kuwoPlaylistDetail(raw map[string]interface{}, fallbackID string) model.Playlist {
	id := firstText(raw, "id", "pid")
	if id == "" {
		id = fallbackID
	}
	return model.Playlist{
		ID: id, Name: normalizeKuwoText(firstText(raw, "title", "name")), Cover: normalizeKuwoImageURL(text(raw["pic"])),
		TrackCount: firstInteger(raw, "total", "validtotal"), PlayCount: integer(raw["playnum"]),
		Creator: normalizeKuwoText(text(raw["uname"])), Description: normalizeKuwoText(text(raw["info"])),
		Source: "kuwo", Link: kuwoPlaylistLink(id),
	}
}

func kuwoAlbums(value interface{}) []model.Playlist {
	items := array(value)
	result := make([]model.Playlist, 0, len(items))
	for _, item := range items {
		album := kuwoAlbum(object(item))
		if album.ID != "" {
			result = append(result, album)
		}
	}
	return result
}

func kuwoAlbum(raw map[string]interface{}) model.Playlist {
	id := firstText(raw, "albumid", "id")
	return model.Playlist{
		ID: id, Name: normalizeKuwoText(firstText(raw, "name", "album")),
		Cover:      normalizeKuwoImageURL(firstText(raw, "hts_img", "img", "pic")),
		TrackCount: firstInteger(raw, "songnum", "musiccnt"), PlayCount: firstInteger(raw, "PLAYCNT", "playcnt"),
		Creator: normalizeKuwoText(firstText(raw, "aartist", "artist")), Description: normalizeKuwoText(text(raw["info"])),
		Source: "kuwo", Link: kuwoAlbumLink(id),
	}
}

func kuwoBrowsePlaylists(value interface{}) []model.Playlist {
	items := array(value)
	result := make([]model.Playlist, 0, len(items))
	for _, item := range items {
		raw := object(item)
		id := text(raw["id"])
		if id == "" {
			continue
		}
		result = append(result, model.Playlist{
			ID: id, Name: normalizeKuwoText(text(raw["name"])), Cover: normalizeKuwoImageURL(text(raw["img"])),
			TrackCount: firstInteger(raw, "songnum", "total", "count", "musicnum"), PlayCount: integer(raw["listencnt"]),
			Creator: normalizeKuwoText(text(raw["uname"])), Description: normalizeKuwoText(firstText(raw, "desc", "info")),
			Source: "kuwo", Link: kuwoPlaylistLink(id),
		})
	}
	return result
}

func normalizeKuwoText(value string) string {
	return strings.TrimSpace(strings.NewReplacer("&nbsp;", " ", "&amp;", "&", "&quot;", "\"").Replace(value))
}

func normalizeKuwoImageURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	value = strings.Replace(value, "_150.", "_700.", 1)
	value = strings.Replace(value, "_120.", "_700.", 1)
	value = strings.Replace(value, "_100.", "_700.", 1)
	if strings.HasPrefix(value, "//") {
		return "http:" + value
	}
	if !strings.HasPrefix(value, "http://") && !strings.HasPrefix(value, "https://") {
		return "http://" + strings.TrimPrefix(value, "/")
	}
	return value
}

func kuwoPlaylistLink(id string) string {
	if id == "" {
		return ""
	}
	return "http://www.kuwo.cn/playlist_detail/" + id
}

func kuwoAlbumLink(id string) string {
	if id == "" {
		return ""
	}
	return "http://www.kuwo.cn/album_detail/" + id
}

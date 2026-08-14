package extensions

import (
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

const (
	qqLegacyBaseURL = "https://c.y.qq.com"
	qqMusicUURL     = "https://u.y.qq.com/cgi-bin/musicu.fcg"
)

type QQ struct {
	Cookie string
}

func NewQQ(cookie string) *QQ {
	return &QQ{Cookie: strings.TrimSpace(cookie)}
}

func qqHeaders() http.Header {
	headers := make(http.Header)
	headers.Set("Referer", "https://y.qq.com/")
	return headers
}

func (client *QQ) SearchPlaylist(keyword string) ([]model.Playlist, error) {
	payload, err := client.search(keyword, 3)
	if err != nil {
		return nil, err
	}
	return qqPlaylists(at(payload, "req", "data", "body", "songlist", "list")), nil
}

func (client *QQ) SearchAlbum(keyword string) ([]model.Playlist, error) {
	payload, err := client.search(keyword, 2)
	if err != nil {
		return nil, err
	}
	return qqAlbums(at(payload, "req", "data", "body", "album", "list")), nil
}

func (client *QQ) search(keyword string, searchType int) (map[string]interface{}, error) {
	payload := map[string]interface{}{
		"req": map[string]interface{}{
			"module": "music.search.SearchCgiService", "method": "DoSearchForQQMusicDesktop",
			"param": map[string]interface{}{
				"query": strings.TrimSpace(keyword), "num_per_page": 30,
				"page_num": 1, "search_type": searchType,
			},
		},
	}
	return postJSON(qqMusicUURL, client.Cookie, qqHeaders(), payload)
}

func (client *QQ) GetPlaylistSongs(id string) ([]model.Song, error) {
	_, songs, err := client.Playlist(id)
	return songs, err
}

func (client *QQ) GetAlbumSongs(id string) ([]model.Song, error) {
	_, songs, err := client.Album(id)
	return songs, err
}

func (client *QQ) Playlist(id string) (*model.Playlist, []model.Song, error) {
	query := url.Values{
		"type": {"1"}, "json": {"1"}, "utf8": {"1"}, "onlysong": {"0"},
		"disstid": {strings.TrimSpace(id)}, "format": {"json"},
	}
	payload, err := getJSON(qqLegacyBaseURL+"/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?"+query.Encode(), client.Cookie, qqHeaders())
	if err != nil {
		return nil, nil, err
	}
	items := array(payload["cdlist"])
	if len(items) == 0 {
		return nil, nil, errorsForEmpty("qq playlist")
	}
	raw := object(items[0])
	playlist := qqPlaylist(raw)
	return &playlist, qqSongs(raw["songlist"]), nil
}

func (client *QQ) ParsePlaylist(link string) (*model.Playlist, []model.Song, error) {
	id := linkID(link, "id", "disstid")
	if id == "" {
		return nil, nil, fmt.Errorf("qq playlist link has no id")
	}
	return client.Playlist(id)
}

func (client *QQ) Album(id string) (*model.Playlist, []model.Song, error) {
	query := url.Values{"albummid": {strings.TrimSpace(id)}, "format": {"json"}}
	payload, err := getJSON(qqLegacyBaseURL+"/v8/fcg-bin/fcg_v8_album_info_cp.fcg?"+query.Encode(), client.Cookie, qqHeaders())
	if err != nil {
		return nil, nil, err
	}
	raw := object(payload["data"])
	if len(raw) == 0 {
		return nil, nil, errorsForEmpty("qq album")
	}
	album := qqAlbum(raw)
	return &album, qqSongs(raw["list"]), nil
}

func (client *QQ) ParseAlbum(link string) (*model.Playlist, []model.Song, error) {
	id := linkID(link, "albummid")
	if id == "" {
		return nil, nil, fmt.Errorf("qq album link has no id")
	}
	return client.Album(id)
}

func (client *QQ) RecommendedPlaylists() ([]model.Playlist, error) {
	return client.CategoryPlaylists("10000000", 1, 30)
}

func (client *QQ) PlaylistCategories() ([]model.PlaylistCategory, error) {
	payload, err := getJSON(qqLegacyBaseURL+"/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg?format=json", client.Cookie, qqHeaders())
	if err != nil {
		return nil, err
	}
	result := make([]model.PlaylistCategory, 0)
	for _, groupValue := range array(at(payload, "data", "categories")) {
		group := object(groupValue)
		groupName := text(group["categoryGroupName"])
		for _, itemValue := range array(group["items"]) {
			item := object(itemValue)
			id := text(item["categoryId"])
			name := text(item["categoryName"])
			if id == "" || name == "" {
				continue
			}
			result = append(result, model.PlaylistCategory{ID: id, Name: name, Group: groupName, Source: "qq", Hot: id == "10000000"})
		}
	}
	return result, nil
}

func (client *QQ) CategoryPlaylists(categoryID string, page, limit int) ([]model.Playlist, error) {
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 30
	}
	start := (page - 1) * limit
	query := url.Values{
		"format": {"json"}, "categoryId": {strings.TrimSpace(categoryID)},
		"sortId": {"5"}, "sin": {strconv.Itoa(start)}, "ein": {strconv.Itoa(start + limit - 1)},
	}
	payload, err := getJSON(qqLegacyBaseURL+"/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?"+query.Encode(), client.Cookie, qqHeaders())
	if err != nil {
		return nil, err
	}
	return qqPlaylists(at(payload, "data", "list")), nil
}

func (client *QQ) UserPlaylists(page, limit int) ([]model.Playlist, error) {
	uin := qqCookieUIN(client.Cookie)
	if uin == "" {
		return nil, fmt.Errorf("qq login cookie is required")
	}
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 50
	}
	query := url.Values{
		"hostuin": {uin}, "sin": {strconv.Itoa((page - 1) * limit)},
		"size": {strconv.Itoa(limit)}, "format": {"json"},
	}
	payload, err := getJSON(qqLegacyBaseURL+"/rsc/fcgi-bin/fcg_user_created_diss?"+query.Encode(), client.Cookie, qqHeaders())
	if err != nil {
		return nil, err
	}
	items := at(payload, "data", "disslist")
	if items == nil {
		items = at(payload, "data", "list")
	}
	return qqPlaylists(items), nil
}

func qqSongs(value interface{}) []model.Song {
	items := array(value)
	result := make([]model.Song, 0, len(items))
	for _, item := range items {
		raw := object(item)
		id := text(raw["songmid"])
		if id == "" {
			id = text(raw["mid"])
		}
		if id == "" {
			id = text(raw["songid"])
		}
		if id == "" {
			continue
		}
		name := text(raw["songname"])
		if name == "" {
			name = text(raw["name"])
		}
		albumID := text(raw["albummid"])
		albumName := text(raw["albumname"])
		album := object(raw["album"])
		if albumID == "" {
			albumID = text(album["mid"])
		}
		if albumName == "" {
			albumName = text(album["name"])
		}
		artists := raw["singer"]
		if artists == nil {
			artists = raw["singer_list"]
		}
		extra := map[string]string{"songmid": id, "album_mid": albumID}
		if integer(at(raw, "pay", "paytrackprice")) > 0 {
			extra["is_paid"] = "1"
		}
		if int64Value(raw["sizeflac"]) > 0 {
			extra["has_lossless"] = "1"
		}
		result = append(result, model.Song{
			ID: id, Name: name, Artist: joinNames(artists, "name"), Album: albumName,
			AlbumID: albumID, Duration: integer(raw["interval"]), Source: "qq",
			Cover: qqAlbumCover(albumID), Extra: extra,
		})
	}
	return result
}

func qqPlaylists(value interface{}) []model.Playlist {
	items := array(value)
	result := make([]model.Playlist, 0, len(items))
	for _, item := range items {
		playlist := qqPlaylist(object(item))
		if playlist.ID != "" {
			result = append(result, playlist)
		}
	}
	return result
}

func qqPlaylist(raw map[string]interface{}) model.Playlist {
	id := text(raw["dissid"])
	if id == "" {
		id = text(raw["disstid"])
	}
	name := text(raw["dissname"])
	cover := text(raw["imgurl"])
	if cover == "" {
		cover = text(raw["logo"])
	}
	trackCount := integer(raw["song_count"])
	if trackCount == 0 {
		trackCount = integer(raw["songnum"])
	}
	return model.Playlist{
		ID: id, Name: name, Cover: cover, TrackCount: trackCount,
		PlayCount: integer(raw["listennum"]), Creator: text(at(raw, "creator", "name")),
		Description: text(raw["introduction"]), Source: "qq",
		Link: "https://y.qq.com/n/ryqq/playlist/" + id,
	}
}

func qqAlbums(value interface{}) []model.Playlist {
	items := array(value)
	result := make([]model.Playlist, 0, len(items))
	for _, item := range items {
		album := qqAlbum(object(item))
		if album.ID != "" {
			result = append(result, album)
		}
	}
	return result
}

func qqAlbum(raw map[string]interface{}) model.Playlist {
	id := text(raw["albumMID"])
	if id == "" {
		id = text(raw["mid"])
	}
	name := text(raw["albumName"])
	if name == "" {
		name = text(raw["name"])
	}
	creator := text(raw["singerName"])
	if creator == "" {
		creator = text(raw["singername"])
	}
	cover := text(raw["albumPic"])
	if cover == "" {
		cover = qqAlbumCover(id)
	}
	count := integer(raw["song_count"])
	if count == 0 {
		count = integer(raw["total_song_num"])
	}
	return model.Playlist{
		ID: id, Name: name, Cover: cover, TrackCount: count, Creator: creator,
		Description: text(raw["desc"]), Source: "qq",
		Link: "https://y.qq.com/n/ryqq/albumDetail/" + id,
	}
}

func qqAlbumCover(albumMID string) string {
	if strings.TrimSpace(albumMID) == "" {
		return ""
	}
	return "https://y.gtimg.cn/music/photo_new/T002R300x300M000" + strings.TrimSpace(albumMID) + ".jpg"
}

func qqCookieUIN(cookie string) string {
	for _, part := range strings.Split(cookie, ";") {
		pair := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(pair) != 2 {
			continue
		}
		name := strings.ToLower(strings.TrimSpace(pair[0]))
		if name != "uin" && name != "qqmusic_uin" && name != "wxuin" {
			continue
		}
		value := strings.TrimLeft(strings.TrimSpace(pair[1]), "o")
		if regexp.MustCompile(`^\d+$`).MatchString(value) {
			return value
		}
	}
	return ""
}

package extensions

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/guohuiyuan/go-music-dl/internal/provider/model"
)

const neteaseBaseURL = "https://music.163.com"

type Netease struct {
	Cookie string
}

func NewNetease(cookie string) *Netease {
	return &Netease{Cookie: strings.TrimSpace(cookie)}
}

func (client *Netease) SearchPlaylist(keyword string) ([]model.Playlist, error) {
	payload, err := client.search(keyword, 1000)
	if err != nil {
		return nil, err
	}
	return neteasePlaylists(at(payload, "result", "playlists")), nil
}

func (client *Netease) SearchAlbum(keyword string) ([]model.Playlist, error) {
	payload, err := client.search(keyword, 10)
	if err != nil {
		return nil, err
	}
	return neteaseAlbums(at(payload, "result", "albums")), nil
}

func (client *Netease) search(keyword string, searchType int) (map[string]interface{}, error) {
	form := url.Values{
		"s": {strings.TrimSpace(keyword)}, "type": {strconv.Itoa(searchType)},
		"limit": {"30"}, "offset": {"0"},
	}
	return postFormJSON(neteaseBaseURL+"/api/search/get/web", client.Cookie, form)
}

func (client *Netease) GetPlaylistSongs(id string) ([]model.Song, error) {
	_, songs, err := client.Playlist(id)
	return songs, err
}

func (client *Netease) GetAlbumSongs(id string) ([]model.Song, error) {
	_, songs, err := client.Album(id)
	return songs, err
}

func (client *Netease) Playlist(id string) (*model.Playlist, []model.Song, error) {
	endpoint := neteaseBaseURL + "/api/v6/playlist/detail?id=" + url.QueryEscape(strings.TrimSpace(id)) + "&n=1000&s=8"
	payload, err := getJSON(endpoint, client.Cookie, nil)
	if err != nil {
		return nil, nil, err
	}
	rawPlaylist := object(payload["playlist"])
	if len(rawPlaylist) == 0 {
		return nil, nil, errorsForEmpty("netease playlist")
	}
	playlist := neteasePlaylist(rawPlaylist)
	return &playlist, neteaseSongs(rawPlaylist["tracks"]), nil
}

func (client *Netease) ParsePlaylist(link string) (*model.Playlist, []model.Song, error) {
	id := linkID(link, "id")
	if id == "" {
		return nil, nil, fmt.Errorf("netease playlist link has no id")
	}
	return client.Playlist(id)
}

func (client *Netease) Album(id string) (*model.Playlist, []model.Song, error) {
	payload, err := getJSON(neteaseBaseURL+"/api/album/"+url.PathEscape(strings.TrimSpace(id)), client.Cookie, nil)
	if err != nil {
		return nil, nil, err
	}
	rawAlbum := object(payload["album"])
	if len(rawAlbum) == 0 {
		return nil, nil, errorsForEmpty("netease album")
	}
	album := neteaseAlbum(rawAlbum)
	return &album, neteaseSongs(payload["songs"]), nil
}

func (client *Netease) ParseAlbum(link string) (*model.Playlist, []model.Song, error) {
	id := linkID(link, "id")
	if id == "" {
		return nil, nil, fmt.Errorf("netease album link has no id")
	}
	return client.Album(id)
}

func (client *Netease) RecommendedPlaylists() ([]model.Playlist, error) {
	payload, err := getJSON(neteaseBaseURL+"/api/personalized/playlist?limit=30", client.Cookie, nil)
	if err != nil {
		return nil, err
	}
	return neteasePlaylists(payload["result"]), nil
}

func (client *Netease) PlaylistCategories() ([]model.PlaylistCategory, error) {
	values := []struct{ group, name string }{
		{"语种", "华语"}, {"语种", "欧美"}, {"语种", "日语"}, {"语种", "韩语"},
		{"风格", "流行"}, {"风格", "摇滚"}, {"风格", "民谣"}, {"风格", "电子"},
		{"场景", "学习"}, {"场景", "运动"}, {"场景", "夜晚"}, {"情感", "怀旧"},
	}
	result := make([]model.PlaylistCategory, 0, len(values))
	for _, value := range values {
		result = append(result, model.PlaylistCategory{ID: value.name, Name: value.name, Group: value.group, Source: "netease"})
	}
	return result, nil
}

func (client *Netease) CategoryPlaylists(categoryID string, page, limit int) ([]model.Playlist, error) {
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 30
	}
	query := url.Values{
		"cat": {strings.TrimSpace(categoryID)}, "order": {"hot"}, "total": {"true"},
		"limit": {strconv.Itoa(limit)}, "offset": {strconv.Itoa((page - 1) * limit)},
	}
	payload, err := getJSON(neteaseBaseURL+"/api/playlist/list?"+query.Encode(), client.Cookie, nil)
	if err != nil {
		return nil, err
	}
	return neteasePlaylists(payload["playlists"]), nil
}

func (client *Netease) UserPlaylists(page, limit int) ([]model.Playlist, error) {
	account, err := getJSON(neteaseBaseURL+"/api/nuser/account/get", client.Cookie, nil)
	if err != nil {
		return nil, err
	}
	userID := text(at(account, "profile", "userId"))
	if userID == "" {
		userID = text(at(account, "account", "id"))
	}
	if userID == "" {
		return nil, fmt.Errorf("netease login cookie is required")
	}
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 50
	}
	query := url.Values{"uid": {userID}, "limit": {strconv.Itoa(limit)}, "offset": {strconv.Itoa((page - 1) * limit)}}
	payload, err := getJSON(neteaseBaseURL+"/api/user/playlist?"+query.Encode(), client.Cookie, nil)
	if err != nil {
		return nil, err
	}
	return neteasePlaylists(payload["playlist"]), nil
}

func (client *Netease) IsVIPAccount() (bool, error) {
	payload, err := getJSON(neteaseBaseURL+"/api/nuser/account/get", client.Cookie, nil)
	if err != nil {
		return false, err
	}
	if text(at(payload, "account", "id")) == "" {
		return false, fmt.Errorf("netease login cookie is invalid")
	}
	return integer(at(payload, "profile", "vipType")) > 0 || integer(at(payload, "account", "vipType")) > 0, nil
}

func neteaseSongs(value interface{}) []model.Song {
	items := array(value)
	result := make([]model.Song, 0, len(items))
	for _, item := range items {
		raw := object(item)
		id := text(raw["id"])
		if id == "" {
			continue
		}
		album := object(raw["al"])
		if len(album) == 0 {
			album = object(raw["album"])
		}
		artists := raw["ar"]
		if artists == nil {
			artists = raw["artists"]
		}
		duration := integer(raw["dt"])
		if duration == 0 {
			duration = integer(raw["duration"])
		}
		result = append(result, model.Song{
			ID: id, Name: text(raw["name"]), Artist: joinNames(artists, "name"),
			Album: text(album["name"]), AlbumID: text(album["id"]), Duration: duration / 1000,
			Source: "netease", Cover: text(album["picUrl"]),
			Extra: map[string]string{"song_id": id, "album_id": text(album["id"])},
		})
	}
	return result
}

func neteasePlaylists(value interface{}) []model.Playlist {
	items := array(value)
	result := make([]model.Playlist, 0, len(items))
	for _, item := range items {
		playlist := neteasePlaylist(object(item))
		if playlist.ID != "" {
			result = append(result, playlist)
		}
	}
	return result
}

func neteasePlaylist(raw map[string]interface{}) model.Playlist {
	cover := text(raw["coverImgUrl"])
	if cover == "" {
		cover = text(raw["picUrl"])
	}
	return model.Playlist{
		ID: text(raw["id"]), Name: text(raw["name"]), Cover: cover,
		TrackCount: integer(raw["trackCount"]), PlayCount: integer(raw["playCount"]),
		Creator: text(at(raw, "creator", "nickname")), Description: text(raw["description"]),
		Source: "netease", Link: "https://music.163.com/playlist?id=" + text(raw["id"]),
	}
}

func neteaseAlbums(value interface{}) []model.Playlist {
	items := array(value)
	result := make([]model.Playlist, 0, len(items))
	for _, item := range items {
		album := neteaseAlbum(object(item))
		if album.ID != "" {
			result = append(result, album)
		}
	}
	return result
}

func neteaseAlbum(raw map[string]interface{}) model.Playlist {
	return model.Playlist{
		ID: text(raw["id"]), Name: text(raw["name"]), Cover: text(raw["picUrl"]),
		TrackCount: integer(raw["size"]), Creator: joinNames(raw["artists"], "name"),
		Description: text(raw["description"]), Source: "netease",
		Link: "https://music.163.com/album?id=" + text(raw["id"]),
	}
}

func errorsForEmpty(kind string) error {
	return fmt.Errorf("%s response is empty", kind)
}

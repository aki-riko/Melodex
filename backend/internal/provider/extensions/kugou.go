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
	kugouSearchPlaylistURL = "https://specialsearch.kugou.com/special_search"
	kugouSearchAlbumURL    = "https://albumsearch.kugou.com/album_search"
	kugouMobileBaseURL     = "http://mobilecdn.kugou.com"
	kugouMobileWebBaseURL  = "http://m.kugou.com"
)

var (
	kugouPlaylistLinkPattern = regexp.MustCompile(`(?i)/yy/special/single/(\d+)(?:\.html)?`)
	kugouAlbumLinkPattern    = regexp.MustCompile(`(?i)/album/(\d+)(?:\.html)?`)
)

type Kugou struct {
	Cookie string
}

func NewKugou(cookie string) *Kugou {
	return &Kugou{Cookie: strings.TrimSpace(cookie)}
}

func kugouHeaders() http.Header {
	headers := make(http.Header)
	headers.Set("Referer", kugouMobileWebBaseURL+"/")
	return headers
}

func (client *Kugou) SearchPlaylist(keyword string) ([]model.Playlist, error) {
	query := url.Values{
		"keyword": {strings.TrimSpace(keyword)}, "page": {"1"}, "pagesize": {"30"},
		"userid": {"0"}, "clientver": {""}, "platform": {"WebFilter"}, "filter": {"0"},
	}
	payload, err := getJSON(kugouSearchPlaylistURL+"?"+query.Encode(), client.Cookie, kugouHeaders())
	if err != nil {
		return nil, err
	}
	return kugouPlaylists(at(payload, "data", "lists")), nil
}

func (client *Kugou) SearchAlbum(keyword string) ([]model.Playlist, error) {
	query := url.Values{
		"keyword": {strings.TrimSpace(keyword)}, "page": {"1"}, "pagesize": {"30"},
		"userid": {"0"}, "clientver": {""}, "platform": {"WebFilter"}, "filter": {"0"},
	}
	payload, err := getJSON(kugouSearchAlbumURL+"?"+query.Encode(), client.Cookie, kugouHeaders())
	if err != nil {
		return nil, err
	}
	return kugouAlbums(at(payload, "data", "lists")), nil
}

func (client *Kugou) GetPlaylistSongs(id string) ([]model.Song, error) {
	_, songs, err := client.Playlist(id)
	return songs, err
}

func (client *Kugou) GetAlbumSongs(id string) ([]model.Song, error) {
	_, songs, err := client.Album(id)
	return songs, err
}

func (client *Kugou) Playlist(id string) (*model.Playlist, []model.Song, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, nil, fmt.Errorf("kugou playlist id is empty")
	}
	infoURL := kugouMobileBaseURL + "/api/v3/special/info?" + url.Values{
		"specialid": {id}, "version": {"9108"}, "area_code": {"1"},
	}.Encode()
	infoPayload, err := getJSON(infoURL, client.Cookie, kugouHeaders())
	if err != nil {
		return nil, nil, err
	}
	if err := validateKugouPayload(infoPayload, "playlist info"); err != nil {
		return nil, nil, err
	}
	playlist := kugouPlaylist(object(infoPayload["data"]))
	if playlist.ID == "" {
		playlist.ID = id
	}
	playlist.Link = kugouPlaylistLink(playlist.ID)

	songs, err := client.collectionSongs("special/song", "specialid", id)
	if err != nil {
		return nil, nil, err
	}
	if playlist.TrackCount == 0 {
		playlist.TrackCount = len(songs)
	}
	return &playlist, songs, nil
}

func (client *Kugou) Album(id string) (*model.Playlist, []model.Song, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, nil, fmt.Errorf("kugou album id is empty")
	}
	infoURL := kugouMobileBaseURL + "/api/v3/album/info?" + url.Values{
		"albumid": {id}, "version": {"9108"}, "area_code": {"1"},
	}.Encode()
	infoPayload, err := getJSON(infoURL, client.Cookie, kugouHeaders())
	if err != nil {
		return nil, nil, err
	}
	if err := validateKugouPayload(infoPayload, "album info"); err != nil {
		return nil, nil, err
	}
	album := kugouAlbum(object(infoPayload["data"]))
	if album.ID == "" {
		album.ID = id
	}
	album.Link = kugouAlbumLink(album.ID)

	songs, err := client.collectionSongs("album/song", "albumid", id)
	if err != nil {
		return nil, nil, err
	}
	for index := range songs {
		if songs[index].Album == "" {
			songs[index].Album = album.Name
		}
		if songs[index].AlbumID == "" {
			songs[index].AlbumID = album.ID
			songs[index].Extra["album_id"] = album.ID
		}
		if songs[index].Cover == "" {
			songs[index].Cover = album.Cover
		}
	}
	if album.TrackCount == 0 {
		album.TrackCount = len(songs)
	}
	return &album, songs, nil
}

func (client *Kugou) collectionSongs(route, idKey, id string) ([]model.Song, error) {
	const pageSize = 300
	result := make([]model.Song, 0)
	for page := 1; page <= 100; page++ {
		query := url.Values{
			idKey: {id}, "page": {strconv.Itoa(page)}, "pagesize": {strconv.Itoa(pageSize)},
			"version": {"9108"}, "area_code": {"1"},
		}
		payload, err := getJSON(kugouMobileBaseURL+"/api/v3/"+route+"?"+query.Encode(), client.Cookie, kugouHeaders())
		if err != nil {
			return nil, err
		}
		if err := validateKugouPayload(payload, route); err != nil {
			return nil, err
		}
		items := array(at(payload, "data", "info"))
		result = append(result, kugouSongs(items)...)
		total := integer(at(payload, "data", "total"))
		if len(items) < pageSize || total > 0 && len(result) >= total {
			break
		}
	}
	if len(result) == 0 {
		return nil, errorsForEmpty("kugou " + route)
	}
	return result, nil
}

func (client *Kugou) ParsePlaylist(link string) (*model.Playlist, []model.Song, error) {
	matches := kugouPlaylistLinkPattern.FindStringSubmatch(strings.TrimSpace(link))
	if len(matches) != 2 {
		return nil, nil, fmt.Errorf("invalid kugou playlist link")
	}
	return client.Playlist(matches[1])
}

func (client *Kugou) ParseAlbum(link string) (*model.Playlist, []model.Song, error) {
	matches := kugouAlbumLinkPattern.FindStringSubmatch(strings.TrimSpace(link))
	if len(matches) != 2 {
		return nil, nil, fmt.Errorf("invalid kugou album link")
	}
	return client.Album(matches[1])
}

func (client *Kugou) RecommendedPlaylists() ([]model.Playlist, error) {
	payload, err := getJSON(kugouMobileWebBaseURL+"/plist/index&json=true", client.Cookie, kugouHeaders())
	if err != nil {
		return nil, err
	}
	playlists := kugouPlaylists(at(payload, "plist", "list", "info"))
	if len(playlists) == 0 {
		return nil, errorsForEmpty("kugou recommendations")
	}
	return playlists, nil
}

func (client *Kugou) PlaylistCategories() ([]model.PlaylistCategory, error) {
	payload, err := getJSON(kugouMobileBaseURL+"/api/v3/tag/list?pid=0&apiver=2&plat=0", client.Cookie, kugouHeaders())
	if err != nil {
		return nil, err
	}
	if err := validateKugouPayload(payload, "playlist categories"); err != nil {
		return nil, err
	}
	result := []model.PlaylistCategory{{ID: "", Name: "全部", Group: "全部", Source: "kugou"}}
	for _, groupValue := range array(at(payload, "data", "info")) {
		group := object(groupValue)
		groupName := text(group["name"])
		for _, childValue := range array(group["children"]) {
			child := object(childValue)
			id := text(child["id"])
			name := text(child["name"])
			if id == "" || name == "" {
				continue
			}
			tagID := text(child["special_tag_id"])
			if tagID == "" {
				tagID = "0"
			}
			result = append(result, model.PlaylistCategory{
				ID: id + ":" + tagID, Name: name, Group: groupName, Source: "kugou",
				Hot:   integer(child["is_hot"]) == 1,
				Extra: map[string]string{"id": id, "tag_id": tagID},
			})
		}
	}
	return result, nil
}

func (client *Kugou) CategoryPlaylists(categoryID string, page, limit int) ([]model.Playlist, error) {
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 30
	}
	id, tagID := parseKugouCategoryID(categoryID)
	if id == "" {
		categories, err := client.PlaylistCategories()
		if err != nil {
			return nil, err
		}
		for _, category := range categories {
			if category.ID != "" {
				id, tagID = parseKugouCategoryID(category.ID)
				break
			}
		}
	}
	if id == "" {
		return nil, fmt.Errorf("kugou playlist category id is empty")
	}
	query := url.Values{
		"plat": {"0"}, "page": {strconv.Itoa(page)}, "pagesize": {strconv.Itoa(limit)},
		"tagid": {tagID}, "ugc": {"1"}, "id": {id}, "sort": {"2"},
	}
	payload, err := getJSON(kugouMobileBaseURL+"/api/v3/tag/specialList?"+query.Encode(), client.Cookie, kugouHeaders())
	if err != nil {
		return nil, err
	}
	if err := validateKugouPayload(payload, "category playlists"); err != nil {
		return nil, err
	}
	playlists := kugouPlaylists(at(payload, "data", "info"))
	if len(playlists) == 0 {
		return nil, errorsForEmpty("kugou category playlists")
	}
	return playlists, nil
}

func validateKugouPayload(payload map[string]interface{}, operation string) error {
	if integer(payload["status"]) != 1 || integer(payload["errcode"]) != 0 {
		return fmt.Errorf("kugou %s failed: status=%d errcode=%d error=%s", operation, integer(payload["status"]), integer(payload["errcode"]), text(payload["error"]))
	}
	return nil
}

func kugouSongs(value interface{}) []model.Song {
	items := array(value)
	result := make([]model.Song, 0, len(items))
	for _, item := range items {
		raw := object(item)
		id := firstText(raw, "hash", "origin_hash", "sqhash", "320hash")
		if id == "" {
			continue
		}
		name := firstText(raw, "songname", "song_name")
		artist := firstText(raw, "singername", "singer_name")
		if name == "" || artist == "" {
			parsedArtist, parsedName := splitArtistTitle(text(raw["filename"]))
			if artist == "" {
				artist = parsedArtist
			}
			if name == "" {
				name = parsedName
			}
		}
		albumID := firstText(raw, "album_id", "albumid")
		album := firstText(raw, "album_name", "remark")
		cover := replaceImageSize(text(at(raw, "trans_param", "union_cover")), "240")
		size := firstInt64(raw, "filesize", "320filesize", "sqfilesize")
		duration := integer(raw["duration"])
		bitrate := integer(raw["bitrate"])
		if bitrate == 0 && duration > 0 && size > 0 {
			bitrate = int(size * 8 / 1000 / int64(duration))
		}
		result = append(result, model.Song{
			ID: id, Name: name, Artist: artist, Album: album, AlbumID: albumID,
			Duration: duration, Size: size, Bitrate: bitrate, Source: "kugou", Cover: cover,
			Link: "https://www.kugou.com/song/#hash=" + id,
			Extra: map[string]string{
				"hash": id, "album_id": albumID, "audio_id": firstText(raw, "audio_id", "album_audio_id"),
				"sq_hash": text(raw["sqhash"]), "hq_hash": text(raw["320hash"]),
				"provider_lookup": strings.TrimSpace(name + " " + artist),
			},
		})
	}
	return result
}

func kugouPlaylists(value interface{}) []model.Playlist {
	items := array(value)
	result := make([]model.Playlist, 0, len(items))
	for _, item := range items {
		playlist := kugouPlaylist(object(item))
		if playlist.ID != "" {
			result = append(result, playlist)
		}
	}
	return result
}

func kugouPlaylist(raw map[string]interface{}) model.Playlist {
	id := firstText(raw, "specialid", "global_specialid")
	creator := firstText(raw, "nickname", "username", "singername")
	return model.Playlist{
		ID: id, Name: text(raw["specialname"]), Cover: replaceImageSize(firstText(raw, "img", "imgurl"), "240"),
		TrackCount: firstInteger(raw, "song_count", "songcount"), PlayCount: firstInteger(raw, "total_play_count", "playcount"),
		Creator: creator, Description: text(raw["intro"]), Source: "kugou", Link: kugouPlaylistLink(id),
	}
}

func kugouAlbums(value interface{}) []model.Playlist {
	items := array(value)
	result := make([]model.Playlist, 0, len(items))
	for _, item := range items {
		album := kugouAlbum(object(item))
		if album.ID != "" {
			result = append(result, album)
		}
	}
	return result
}

func kugouAlbum(raw map[string]interface{}) model.Playlist {
	id := text(raw["albumid"])
	return model.Playlist{
		ID: id, Name: text(raw["albumname"]), Cover: replaceImageSize(firstText(raw, "img", "imgurl"), "240"),
		TrackCount: firstInteger(raw, "songcount", "song_count"), PlayCount: firstInteger(raw, "play_count", "playcount"),
		Creator: firstText(raw, "singer", "singername"), Description: text(raw["intro"]),
		Source: "kugou", Link: kugouAlbumLink(id),
	}
}

func parseKugouCategoryID(value string) (string, string) {
	parts := strings.SplitN(strings.TrimSpace(value), ":", 2)
	id := strings.TrimSpace(parts[0])
	tagID := "0"
	if len(parts) == 2 && strings.TrimSpace(parts[1]) != "" {
		tagID = strings.TrimSpace(parts[1])
	}
	return id, tagID
}

func kugouPlaylistLink(id string) string {
	if id == "" {
		return ""
	}
	return "https://www.kugou.com/yy/special/single/" + id + ".html"
}

func kugouAlbumLink(id string) string {
	if id == "" {
		return ""
	}
	return "https://www.kugou.com/album/" + id + ".html"
}

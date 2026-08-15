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
	miguSearchBaseURL  = "http://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content"
	miguContentBaseURL = "https://app.c.nf.migu.cn"
)

var (
	miguPlaylistLinkPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)playlistId=(\d+)`),
		regexp.MustCompile(`(?i)musicListId=(\d+)`),
		regexp.MustCompile(`(?i)/(?:playlist|songlist)/(\d+)`),
	}
	miguAlbumLinkPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)music\.migu\.cn/(?:v3|v5)/music/album/(\d+)`),
		regexp.MustCompile(`(?i)albumId=(\d+)`),
		regexp.MustCompile(`(?i)resourceId=(\d+)`),
	}
)

type Migu struct {
	Cookie string
}

func NewMigu(cookie string) *Migu {
	return &Migu{Cookie: strings.TrimSpace(cookie)}
}

func miguHeaders() http.Header {
	headers := make(http.Header)
	headers.Set("Referer", "http://music.migu.cn/")
	return headers
}

func (client *Migu) SearchPlaylist(keyword string) ([]model.RemoteCollection, error) {
	return client.searchPlaylists(keyword, 1, 30)
}

func (client *Migu) searchPlaylists(keyword string, page, limit int) ([]model.RemoteCollection, error) {
	query := miguSearchQuery(keyword, page, limit, `{"song":0,"album":0,"singer":0,"tagSong":0,"mvSong":0,"songlist":1,"bestShow":1}`)
	payload, err := getJSON(miguSearchBaseURL+"/search_all.do?"+query.Encode(), client.Cookie, miguHeaders())
	if err != nil {
		return nil, err
	}
	return miguPlaylists(at(payload, "songListResultData", "result")), nil
}

func (client *Migu) SearchAlbum(keyword string) ([]model.RemoteCollection, error) {
	query := miguSearchQuery(keyword, 1, 30, `{"song":0,"album":1,"singer":0,"tagSong":0,"mvSong":0,"songlist":0,"bestShow":1}`)
	payload, err := getJSON(miguSearchBaseURL+"/search_all.do?"+query.Encode(), client.Cookie, miguHeaders())
	if err != nil {
		return nil, err
	}
	albums := miguAlbums(at(payload, "albumResultData", "result"))
	if len(albums) == 0 {
		return nil, errorsForEmpty("migu albums")
	}
	return albums, nil
}

func miguSearchQuery(keyword string, page, limit int, searchSwitch string) url.Values {
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 30
	}
	return url.Values{
		"ua": {"Android_migu"}, "version": {"5.0.1"}, "text": {strings.TrimSpace(keyword)},
		"pageNo": {strconv.Itoa(page)}, "pageSize": {strconv.Itoa(limit)}, "searchSwitch": {searchSwitch},
	}
}

func (client *Migu) GetPlaylistSongs(id string) ([]model.Track, error) {
	return client.playlistSongs(id)
}

func (client *Migu) GetAlbumSongs(id string) ([]model.Track, error) {
	return client.albumSongs(id)
}

func (client *Migu) Playlist(id string) (*model.RemoteCollection, []model.Track, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, nil, fmt.Errorf("migu playlist id is empty")
	}
	songs, err := client.playlistSongs(id)
	if err != nil {
		return nil, nil, err
	}
	playlist, infoErr := client.playlistInfo(id)
	if infoErr != nil {
		playlist = miguPlaylistFallback(id)
	}
	completeMiguPlaylistMetadata(&playlist, songs)
	return &playlist, songs, nil
}

func miguPlaylistFallback(id string) model.RemoteCollection {
	playlist := model.RemoteCollection{}
	playlist.ID, playlist.Name, playlist.Source = id, id, "migu"
	playlist.Link = miguPlaylistLink(id)
	return playlist
}

func completeMiguPlaylistMetadata(playlist *model.RemoteCollection, songs []model.Track) {
	if playlist.TrackCount == 0 {
		playlist.TrackCount = len(songs)
	}
	if playlist.Cover == "" && len(songs) != 0 {
		playlist.Cover = songs[0].Cover
	}
}

func (client *Migu) Album(id string) (*model.RemoteCollection, []model.Track, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, nil, fmt.Errorf("migu album id is empty")
	}
	songs, err := client.albumSongs(id)
	if err != nil {
		return nil, nil, err
	}
	query := url.Values{"needSimple": {"00"}, "resourceType": {"2003"}, "resourceId": {id}}
	payload, err := getJSON(miguContentBaseURL+"/MIGUM2.0/v1.0/content/resourceinfo.do?"+query.Encode(), client.Cookie, miguHeaders())
	if err != nil {
		return nil, nil, err
	}
	if err := validateMiguPayload(payload, "album info"); err != nil {
		return nil, nil, err
	}
	resources := array(payload["resource"])
	if len(resources) == 0 {
		return nil, nil, errorsForEmpty("migu album info")
	}
	album := miguAlbumDetail(object(resources[0]), id)
	if album.TrackCount == 0 {
		album.TrackCount = len(songs)
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
	return &album, songs, nil
}

func (client *Migu) playlistInfo(id string) (model.RemoteCollection, error) {
	query := url.Values{"needSimple": {"00"}, "resourceType": {"2021"}, "resourceId": {id}}
	payload, err := getJSON(miguContentBaseURL+"/MIGUM2.0/v1.0/content/resourceinfo.do?"+query.Encode(), client.Cookie, miguHeaders())
	if err != nil {
		return model.RemoteCollection{}, err
	}
	if err := validateMiguPayload(payload, "playlist info"); err != nil {
		return model.RemoteCollection{}, err
	}
	resources := array(payload["resource"])
	if len(resources) == 0 {
		return model.RemoteCollection{}, errorsForEmpty("migu playlist info")
	}
	raw := object(resources[0])
	playlistID := firstText(raw, "musicListId", "id")
	if playlistID == "" {
		playlistID = id
	}
	cover := firstText(raw, "originalImgUrl")
	if cover == "" {
		cover = firstText(object(raw["imgItem"]), "img", "webpImg", "imgOri")
	}
	return model.RemoteCollection{
		ID: playlistID, Name: firstText(raw, "title", "name"), Cover: normalizeMiguImageURL(cover),
		TrackCount: integer(raw["musicNum"]), PlayCount: integer(at(raw, "opNumItem", "playNum")),
		Creator: text(raw["ownerName"]), Description: text(raw["summary"]), Source: "migu",
		Link: miguPlaylistLink(playlistID), Extra: map[string]string{"type": "playlist", "playlist_id": playlistID},
	}, nil
}

func (client *Migu) playlistSongs(id string) ([]model.Track, error) {
	return client.collectionSongs(
		miguContentBaseURL+"/MIGUM3.0/resource/playlist/song/v2.0",
		"playlistId", strings.TrimSpace(id), "migu playlist",
	)
}

func (client *Migu) albumSongs(id string) ([]model.Track, error) {
	return client.collectionSongs(
		miguContentBaseURL+"/MIGUM2.0/v1.0/content/queryAlbumSong",
		"albumId", strings.TrimSpace(id), "migu album",
	)
}

func (client *Migu) collectionSongs(endpoint, idKey, id, operation string) ([]model.Track, error) {
	if id == "" {
		return nil, fmt.Errorf("%s id is empty", operation)
	}
	const pageSize = 50
	result := make([]model.Track, 0)
	seen := make(map[string]struct{})
	for page := 1; page <= 100; page++ {
		query := url.Values{
			idKey: {id}, "pageNo": {strconv.Itoa(page)}, "pageSize": {strconv.Itoa(pageSize)},
		}
		payload, err := getJSON(endpoint+"?"+query.Encode(), client.Cookie, miguHeaders())
		if err != nil {
			return nil, err
		}
		if err := validateMiguPayload(payload, operation); err != nil {
			return nil, err
		}
		items := array(at(payload, "data", "songList"))
		for _, song := range miguSongs(items) {
			if _, ok := seen[song.ID]; ok {
				continue
			}
			seen[song.ID] = struct{}{}
			result = append(result, song)
		}
		total := integer(at(payload, "data", "totalCount"))
		if len(items) < pageSize || total > 0 && len(result) >= total {
			break
		}
	}
	if len(result) == 0 {
		return nil, errorsForEmpty(operation)
	}
	return result, nil
}

func (client *Migu) ParsePlaylist(link string) (*model.RemoteCollection, []model.Track, error) {
	link = strings.TrimSpace(link)
	for _, pattern := range miguPlaylistLinkPatterns {
		if matches := pattern.FindStringSubmatch(link); len(matches) == 2 {
			return client.Playlist(matches[1])
		}
	}
	if link != "" && !strings.Contains(link, "/") {
		return client.Playlist(link)
	}
	return nil, nil, fmt.Errorf("invalid migu playlist link")
}

func (client *Migu) ParseAlbum(link string) (*model.RemoteCollection, []model.Track, error) {
	for _, pattern := range miguAlbumLinkPatterns {
		if matches := pattern.FindStringSubmatch(strings.TrimSpace(link)); len(matches) == 2 {
			return client.Album(matches[1])
		}
	}
	return nil, nil, fmt.Errorf("invalid migu album link")
}

func (client *Migu) PlaylistCategories() ([]model.RemoteCategory, error) {
	values := []struct {
		group string
		name  string
		hot   bool
	}{
		{"语种", "华语", true}, {"语种", "欧美", true}, {"语种", "日语", false},
		{"语种", "韩语", false}, {"语种", "粤语", false}, {"风格", "流行", true},
		{"风格", "摇滚", true}, {"风格", "民谣", true}, {"风格", "电子", false},
		{"风格", "说唱", false}, {"风格", "古风", false}, {"风格", "轻音乐", false},
		{"场景", "影视", true}, {"场景", "ACG", false}, {"场景", "治愈", false},
		{"场景", "运动", false}, {"场景", "学习", false}, {"场景", "睡前", false},
	}
	result := []model.RemoteCategory{{ID: "", Name: "全部", Group: "全部", Source: "migu"}}
	for _, value := range values {
		result = append(result, model.RemoteCategory{
			ID: value.name, Name: value.name, Group: value.group, Source: "migu", Hot: value.hot,
		})
	}
	return result, nil
}

func (client *Migu) CategoryPlaylists(categoryID string, page, limit int) ([]model.RemoteCollection, error) {
	categoryID = strings.TrimSpace(categoryID)
	if categoryID == "" {
		categoryID = "华语"
	}
	playlists, err := client.searchPlaylists(categoryID, page, limit)
	if err != nil {
		return nil, err
	}
	if len(playlists) == 0 {
		return nil, errorsForEmpty("migu category playlists")
	}
	for index := range playlists {
		if playlists[index].Extra == nil {
			playlists[index].Extra = make(map[string]string)
		}
		playlists[index].Extra["category_id"] = categoryID
	}
	return playlists, nil
}

func validateMiguPayload(payload map[string]interface{}, operation string) error {
	code := text(payload["code"])
	if code != "" && code != "000000" {
		return fmt.Errorf("migu %s failed: code=%s info=%s", operation, code, text(payload["info"]))
	}
	return nil
}

func miguSongs(value interface{}) []model.Track {
	items := array(value)
	result := make([]model.Track, 0, len(items))
	for _, item := range items {
		raw := object(item)
		id := firstText(raw, "contentId", "songId", "copyrightId", "id")
		if id == "" {
			continue
		}
		name := firstText(raw, "songName", "name")
		artist := joinMiguNames(firstArray(raw, "singerList", "singers", "artists"))
		if artist == "" {
			artist = text(raw["singer"])
		}
		album := text(raw["album"])
		albumID := text(raw["albumId"])
		if albums := array(raw["albums"]); len(albums) > 0 {
			if album == "" {
				album = text(object(albums[0])["name"])
			}
			if albumID == "" {
				albumID = text(object(albums[0])["id"])
			}
		}
		size, ext := bestMiguFormat(firstArray(raw, "audioFormats", "rateFormats", "newRateFormats"))
		duration := integer(raw["duration"])
		bitrate := 0
		if size > 0 && duration > 0 {
			bitrate = int(size * 8 / 1000 / int64(duration))
		}
		cover := firstText(raw, "img1", "img2", "img3")
		if cover == "" {
			cover = pickMiguImage(firstArray(raw, "imgItems", "albumImgs"))
		}
		result = append(result, model.Track{
			ID: id, Name: name, Artist: artist, Album: album, AlbumID: albumID,
			Duration: duration, Size: size, Bitrate: bitrate, Source: "migu", Ext: ext,
			Cover: normalizeMiguImageURL(cover), Link: "https://music.migu.cn/v3/music/song/" + id,
			Extra: map[string]string{
				"content_id": text(raw["contentId"]), "copyright_id": text(raw["copyrightId"]),
				"album_id": albumID, "provider_lookup": strings.TrimSpace(name + " " + artist),
			},
		})
	}
	return result
}

func miguPlaylists(value interface{}) []model.RemoteCollection {
	items := array(value)
	result := make([]model.RemoteCollection, 0, len(items))
	for _, item := range items {
		raw := object(item)
		id := text(raw["id"])
		name := text(raw["name"])
		if id == "" || name == "" {
			continue
		}
		cover := firstText(raw, "musicListPicUrl")
		if cover == "" {
			cover = pickMiguImage(raw["imgItems"])
		}
		result = append(result, model.RemoteCollection{
			ID: id, Name: name, Cover: normalizeMiguImageURL(cover), TrackCount: integer(raw["musicNum"]),
			PlayCount: integer(raw["playNum"]), Creator: firstText(raw, "userName", "ownerName"),
			Source: "migu", Link: miguPlaylistLink(id),
			Extra: map[string]string{"type": "playlist", "playlist_id": id},
		})
	}
	return result
}

func miguAlbums(value interface{}) []model.RemoteCollection {
	items := array(value)
	result := make([]model.RemoteCollection, 0, len(items))
	for _, item := range items {
		raw := object(item)
		id := text(raw["id"])
		if id == "" {
			continue
		}
		result = append(result, model.RemoteCollection{
			ID: id, Name: text(raw["name"]), Cover: normalizeMiguImageURL(pickMiguImage(raw["imgItems"])),
			Creator: text(raw["singer"]), Description: firstText(raw, "desc", "publishDate"),
			Source: "migu", Link: miguAlbumLink(id),
			Extra: map[string]string{"type": "album", "album_id": id, "resource_type": text(raw["resourceType"])},
		})
	}
	return result
}

func miguAlbumDetail(raw map[string]interface{}, fallbackID string) model.RemoteCollection {
	id := firstText(raw, "albumId", "id")
	if id == "" {
		id = fallbackID
	}
	return model.RemoteCollection{
		ID: id, Name: text(raw["title"]), Cover: normalizeMiguImageURL(pickMiguImage(raw["imgItems"])),
		TrackCount: integer(raw["totalCount"]), PlayCount: integer(at(raw, "opNumItem", "playNum")),
		Creator: text(raw["singer"]), Description: text(raw["summary"]), Source: "migu",
		Link: miguAlbumLink(id), Extra: map[string]string{"type": "album", "album_id": id},
	}
}

func firstArray(values map[string]interface{}, keys ...string) interface{} {
	for _, key := range keys {
		if items := array(values[key]); len(items) > 0 {
			return items
		}
	}
	return nil
}

func joinMiguNames(value interface{}) string {
	names := make([]string, 0)
	for _, item := range array(value) {
		if name := text(object(item)["name"]); name != "" {
			names = append(names, name)
		}
	}
	return strings.Join(names, " / ")
}

func pickMiguImage(value interface{}) string {
	items := array(value)
	for _, preferred := range []string{"02", "01", "03"} {
		for _, item := range items {
			raw := object(item)
			if text(raw["imgSizeType"]) == preferred && text(raw["img"]) != "" {
				return text(raw["img"])
			}
		}
	}
	for _, item := range items {
		if image := firstText(object(item), "img", "webpImg", "imgOri"); image != "" {
			return image
		}
	}
	return ""
}

func bestMiguFormat(value interface{}) (int64, string) {
	var bestSize int64
	ext := "mp3"
	for _, item := range array(value) {
		raw := object(item)
		size := firstInt64(raw, "asize", "androidSize", "size", "isize")
		if size <= bestSize {
			continue
		}
		bestSize = size
		formatType := strings.ToUpper(text(raw["formatType"]))
		formatCode := firstText(raw, "aformat", "androidFileType", "fileType", "iformat")
		if strings.Contains(formatType, "SQ") || strings.HasPrefix(formatCode, "011") {
			ext = "flac"
		} else {
			ext = "mp3"
		}
	}
	return bestSize, ext
}

func normalizeMiguImageURL(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "//") {
		return "https:" + value
	}
	if strings.HasPrefix(value, "/") {
		return "https://d.musicapp.migu.cn" + value
	}
	return value
}

func miguPlaylistLink(id string) string {
	return "https://music.migu.cn/v5/#/playlist?playlistId=" + id + "&playlistType=ordinary"
}

func miguAlbumLink(id string) string {
	return "https://music.migu.cn/v3/music/album/" + id
}

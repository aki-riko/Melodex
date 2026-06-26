package web

// Subsonic facade —— getCoverArt + 曲库浏览端点。
//
// 曲库数据源:共享下载目录的扫描快照(复用 local_music 扫描)。
// 「听过自动入库」的歌会沉淀在这里,客户端可按专辑/艺人浏览。
//
//   - getCoverArt   : 本地嵌入封面优先,在线源 id 则代理在线封面(复用 SSRF 防护)
//   - getMusicFolders/getIndexes/getArtists : 曲库目录
//   - getAlbumList2/getAlbum                 : 按专辑浏览
//   - getLyrics                              : 复用现有 LRC

import (
	"encoding/base64"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/guohuiyuan/go-music-dl/core"
)

// localTrackToSubsonicChild 把本地曲库 track 映射成 Subsonic song 元素。
func localTrackToSubsonicChild(t *localMusicTrack) subsonicChild {
	if t == nil {
		return subsonicChild{}
	}
	id := encodeLocalSongID(t.ID)
	suffix := strings.ToLower(strings.TrimPrefix(t.Ext, "."))
	if suffix == "" {
		suffix = "mp3"
	}
	child := subsonicChild{
		ID:          id,
		IsDir:       false,
		Title:       t.Name,
		Album:       t.Album,
		Artist:      t.Artist,
		CoverArt:    id,
		Duration:    t.Duration,
		Size:        t.Size,
		Suffix:      suffix,
		ContentType: localAudioMimeByExt(suffix),
		Type:        "music",
	}
	if t.Album != "" {
		child.AlbumID = albumSyntheticID(t.Album)
	}
	if t.Artist != "" {
		child.ArtistID = artistSyntheticID(t.Artist)
	}
	return child
}

// albumSyntheticID / artistSyntheticID 由名称派生稳定 id(曲库浏览用)。
func albumSyntheticID(album string) string {
	return "album:" + encodeNameID(album)
}

func artistSyntheticID(artist string) string {
	return "artist:" + encodeNameID(artist)
}

// subsonicGetCoverArt 返回封面图片(二进制)。
// id 为本地曲库 id → 读嵌入封面;为在线源 id → 代理在线封面 URL。
func subsonicGetCoverArt(c *gin.Context) {
	id := strings.TrimSpace(c.Query("id"))
	if id == "" {
		respondSubsonicError(c, errSubsonicMissingParam)
		return
	}

	// 本地曲库封面:读文件嵌入图。
	if localTrackID, ok := decodeLocalSongID(id); ok {
		track, err := localMusicTrackByID(localTrackID)
		if err != nil {
			respondSubsonicError(c, errSubsonicNotFound)
			return
		}
		data, mimeType, _, err := readLocalMusicCover(track)
		if err != nil || len(data) == 0 {
			respondSubsonicError(c, errSubsonicNotFound)
			return
		}
		c.Header("Cache-Control", "public, max-age=21600")
		c.Data(200, mimeType, data)
		return
	}

	// 在线源封面:代理 cover URL(SSRF 防护)。
	if song, ok := decodeOnlineSongID(id); ok && song.Cover != "" {
		if err := isPublicHTTPURL(song.Cover); err != nil {
			respondSubsonicError(c, errSubsonicNotFound)
			return
		}
		data, contentType, err := core.FetchBytesWithMime(song.Cover, song.Source)
		if err != nil || len(data) == 0 {
			respondSubsonicError(c, errSubsonicNotFound)
			return
		}
		if contentType == "" {
			contentType = "image/jpeg"
		}
		c.Header("Cache-Control", "public, max-age=21600")
		c.Data(200, contentType, data)
		return
	}

	respondSubsonicError(c, errSubsonicNotFound)
}

// encodeNameID 把名称编码成稳定的 url-safe id 片段。
func encodeNameID(name string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(name))
}

// decodeNameID 还原 encodeNameID / 合成 id(album:xxx / artist:xxx)的名称部分。
func decodeNameID(id string) (string, bool) {
	s := id
	if i := strings.Index(s, ":"); i >= 0 {
		s = s[i+1:]
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return "", false
	}
	return string(raw), true
}

// loadLibraryTracks 取共享下载目录的扫描快照(已入库的歌)。
func loadLibraryTracks() []*localMusicTrack {
	tracks, _, exists, _, _, _ := scanLocalMusicTracksCached(false)
	if !exists {
		return nil
	}
	return tracks
}

// subsonicGetMusicFolders 返回单一音乐目录(共享下载目录)。
func subsonicGetMusicFolders(c *gin.Context) {
	resp := newSubsonicOK()
	resp.MusicFolders = &musicFoldersBody{
		MusicFolders: []subsonicMusicFolder{{ID: 0, Name: "TuneScout+ 曲库"}},
	}
	respondSubsonic(c, resp)
}

// aggregateArtists 把曲库按艺人聚合,返回排序后的艺人列表(含专辑数)。
func aggregateArtists(tracks []*localMusicTrack) []subsonicArtist {
	albumsByArtist := make(map[string]map[string]bool)
	for _, t := range tracks {
		if t == nil || t.Artist == "" {
			continue
		}
		if albumsByArtist[t.Artist] == nil {
			albumsByArtist[t.Artist] = make(map[string]bool)
		}
		if t.Album != "" {
			albumsByArtist[t.Artist][t.Album] = true
		}
	}
	artists := make([]subsonicArtist, 0, len(albumsByArtist))
	for name, albums := range albumsByArtist {
		artists = append(artists, subsonicArtist{
			ID:         artistSyntheticID(name),
			Name:       name,
			AlbumCount: len(albums),
		})
	}
	sort.Slice(artists, func(i, j int) bool {
		return strings.ToLower(artists[i].Name) < strings.ToLower(artists[j].Name)
	})
	return artists
}

// buildIndexes 把艺人按首字母分组成 Subsonic index。
func buildIndexes(artists []subsonicArtist) []subsonicIndex {
	groups := make(map[string][]subsonicArtist)
	var order []string
	for _, a := range artists {
		key := "#"
		if a.Name != "" {
			r := []rune(a.Name)[0]
			key = strings.ToUpper(string(r))
		}
		if _, ok := groups[key]; !ok {
			order = append(order, key)
		}
		groups[key] = append(groups[key], a)
	}
	sort.Strings(order)
	indexes := make([]subsonicIndex, 0, len(order))
	for _, k := range order {
		indexes = append(indexes, subsonicIndex{Name: k, Artists: groups[k]})
	}
	return indexes
}

// subsonicGetIndexes / subsonicGetArtists 返回艺人索引(曲库目录)。
func subsonicGetIndexes(c *gin.Context) {
	artists := aggregateArtists(loadLibraryTracks())
	resp := newSubsonicOK()
	resp.Indexes = &indexesBody{LastModified: 0, Index: buildIndexes(artists)}
	respondSubsonic(c, resp)
}

func subsonicGetArtists(c *gin.Context) {
	artists := aggregateArtists(loadLibraryTracks())
	resp := newSubsonicOK()
	resp.Artists = &artistsBody{Index: buildIndexes(artists)}
	respondSubsonic(c, resp)
}

// aggregateAlbums 把曲库按专辑聚合(专辑名为空的归到「未知专辑」)。
func aggregateAlbums(tracks []*localMusicTrack) []subsonicAlbum {
	type albumAgg struct {
		name      string
		artist    string
		songCount int
		coverID   string
	}
	byName := make(map[string]*albumAgg)
	var order []string
	for _, t := range tracks {
		if t == nil {
			continue
		}
		albumName := t.Album
		if albumName == "" {
			albumName = "未知专辑"
		}
		agg, ok := byName[albumName]
		if !ok {
			agg = &albumAgg{name: albumName, artist: t.Artist, coverID: encodeLocalSongID(t.ID)}
			byName[albumName] = agg
			order = append(order, albumName)
		}
		agg.songCount++
	}
	albums := make([]subsonicAlbum, 0, len(order))
	for _, name := range order {
		agg := byName[name]
		albums = append(albums, subsonicAlbum{
			ID:        albumSyntheticID(agg.name),
			Name:      agg.name,
			Artist:    agg.artist,
			ArtistID:  artistSyntheticID(agg.artist),
			CoverArt:  agg.coverID,
			SongCount: agg.songCount,
		})
	}
	return albums
}

// subsonicGetAlbumList2 返回专辑列表(曲库浏览)。
func subsonicGetAlbumList2(c *gin.Context) {
	albums := aggregateAlbums(loadLibraryTracks())
	sort.Slice(albums, func(i, j int) bool {
		return strings.ToLower(albums[i].Name) < strings.ToLower(albums[j].Name)
	})
	resp := newSubsonicOK()
	resp.AlbumList2 = &albumList2Body{Albums: albums}
	respondSubsonic(c, resp)
}

// subsonicGetAlbum 返回单个专辑的歌曲列表。id 为 album:<base64(name)>。
func subsonicGetAlbum(c *gin.Context) {
	id := strings.TrimSpace(c.Query("id"))
	name, ok := decodeNameID(id)
	if !ok || name == "" {
		respondSubsonicError(c, errSubsonicNotFound)
		return
	}
	tracks := loadLibraryTracks()
	songs := make([]subsonicChild, 0)
	var artist, coverID string
	for _, t := range tracks {
		if t == nil {
			continue
		}
		albumName := t.Album
		if albumName == "" {
			albumName = "未知专辑"
		}
		if albumName != name {
			continue
		}
		songs = append(songs, localTrackToSubsonicChild(t))
		if artist == "" {
			artist = t.Artist
		}
		if coverID == "" {
			coverID = encodeLocalSongID(t.ID)
		}
	}
	if len(songs) == 0 {
		respondSubsonicError(c, errSubsonicNotFound)
		return
	}
	resp := newSubsonicOK()
	resp.Album = &albumBody{subsonicAlbum{
		ID:        albumSyntheticID(name),
		Name:      name,
		Artist:    artist,
		ArtistID:  artistSyntheticID(artist),
		CoverArt:  coverID,
		SongCount: len(songs),
		Songs:     songs,
	}}
	respondSubsonic(c, resp)
}

// subsonicGetArtist 返回单个艺人的专辑列表。id 为 artist:<base64(name)>。
func subsonicGetArtist(c *gin.Context) {
	id := strings.TrimSpace(c.Query("id"))
	name, ok := decodeNameID(id)
	if !ok || name == "" {
		respondSubsonicError(c, errSubsonicNotFound)
		return
	}
	tracks := loadLibraryTracks()
	artistTracks := make([]*localMusicTrack, 0)
	for _, t := range tracks {
		if t != nil && t.Artist == name {
			artistTracks = append(artistTracks, t)
		}
	}
	if len(artistTracks) == 0 {
		respondSubsonicError(c, errSubsonicNotFound)
		return
	}
	albums := aggregateAlbums(artistTracks)
	resp := newSubsonicOK()
	resp.Artist = &artistBody{
		subsonicArtist: subsonicArtist{ID: artistSyntheticID(name), Name: name, AlbumCount: len(albums)},
		Albums:         albums,
	}
	respondSubsonic(c, resp)
}

// subsonicGetLyrics 返回歌词(本期返回空 lyrics 占位,客户端多从嵌入标签读)。
func subsonicGetLyrics(c *gin.Context) {
	resp := newSubsonicOK()
	resp.Lyrics = &lyricsBody{
		Artist: strings.TrimSpace(c.Query("artist")),
		Title:  strings.TrimSpace(c.Query("title")),
	}
	respondSubsonic(c, resp)
}

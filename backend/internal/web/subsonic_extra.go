package web

// Subsonic facade —— 补充端点(音流播放页/各界面用到):
//   - getSong         : 单曲详情(播放页拿 coverArt id 的关键)
//   - getSimilarSongs(2): 相似歌曲(本期回空列表,避免客户端报错)
//   - getRandomSongs  : 随机歌曲(取曲库已入库)
//   - getArtistInfo2  : 艺人大图(用搜索记下的封面)
//   - getScanStatus/startScan : 扫描状态
//   - getPlaylists    : 歌单(本期空)
//   - scrobble/star/unstar : 接受并回 ok

import (
	"strings"

	"github.com/gin-gonic/gin"
)

// subsonicGetSong 返回单曲详情。id 为在线源(ts1:)直接解码;本地(loc:)查曲库。
func subsonicGetSong(c *gin.Context) {
	id := strings.TrimSpace(c.Query("id"))
	if id == "" {
		respondSubsonicError(c, errSubsonicMissingParam)
		return
	}
	// 本地曲库歌曲
	if localTrackID, ok := decodeLocalSongID(id); ok {
		if track, err := localMusicTrackByID(localTrackID); err == nil {
			child := localTrackToSubsonicChild(track)
			resp := newSubsonicOK()
			resp.Song = &child
			respondSubsonic(c, resp)
			return
		}
		respondSubsonicError(c, errSubsonicNotFound)
		return
	}
	// 在线源歌曲:解码 id 得基本信息。验活回填真实格式/大小/码率 ——
	// id 里不含 Ext,不验活会误报 mp3,FLAC 歌会被客户端按 mp3 解码播不出。
	if song, ok := decodeOnlineSongID(id); ok {
		if okLive, size, ext := liveCheckSong(song); okLive {
			if ext != "" {
				song.Ext = ext
			}
			if size > 0 {
				song.Size = size
				if song.Duration > 0 {
					song.Bitrate = int((size * 8) / int64(song.Duration) / 1000)
				}
			}
		}
		child := songToSubsonicChild(song)
		resp := newSubsonicOK()
		resp.Song = &child
		respondSubsonic(c, resp)
		return
	}
	respondSubsonicError(c, errSubsonicNotFound)
}

// subsonicGetSimilarSongs 相似歌曲:本期回空列表(无相似度数据源,回空避免客户端报错)。
func subsonicGetSimilarSongs(c *gin.Context) {
	resp := newSubsonicOK()
	resp.SimilarSongs2 = &songsListBody{Songs: []subsonicChild{}}
	respondSubsonic(c, resp)
}

// subsonicGetRandomSongs 随机歌曲:取曲库已入库的歌(按扫描顺序,够用)。
func subsonicGetRandomSongs(c *gin.Context) {
	size := parseIntDefault(c.Query("size"), 10)
	tracks := loadLibraryTracks()
	songs := make([]subsonicChild, 0, size)
	for _, t := range tracks {
		if t == nil {
			continue
		}
		songs = append(songs, localTrackToSubsonicChild(t))
		if len(songs) >= size {
			break
		}
	}
	resp := newSubsonicOK()
	resp.RandomSongs = &songsListBody{Songs: songs}
	respondSubsonic(c, resp)
}

// subsonicGetArtistInfo2 艺人信息:回大图 URL(用搜索时记下的在线封面)。
func subsonicGetArtistInfo2(c *gin.Context) {
	id := strings.TrimSpace(c.Query("id"))
	resp := newSubsonicOK()
	info := &artistInfo2Body{}
	// id 是合成 artist: id,反查封面 URL 作大图。
	if coverURL := resolveSyntheticCoverURL(id); coverURL != "" {
		info.SmallImageURL = coverURL
		info.MediumImageURL = coverURL
		info.LargeImageURL = coverURL
	}
	resp.ArtistInfo2 = info
	respondSubsonic(c, resp)
}

// subsonicGetScanStatus 扫描状态:facade 不做主动扫描,恒返回未在扫描 + 曲库数。
func subsonicGetScanStatus(c *gin.Context) {
	tracks := loadLibraryTracks()
	resp := newSubsonicOK()
	resp.ScanStatus = &scanStatusBody{Scanning: false, Count: len(tracks)}
	respondSubsonic(c, resp)
}

// subsonicGetPlaylists 歌单:本期回空(facade 不管理歌单)。
func subsonicGetPlaylists(c *gin.Context) {
	resp := newSubsonicOK()
	resp.Playlists = &playlistsBody{Playlists: []subsonicPlaylist{}}
	respondSubsonic(c, resp)
}

// subsonicEmptyOK 接受并返回空 ok(scrobble/star/unstar 等无副作用上报)。
func subsonicEmptyOK(c *gin.Context) {
	respondSubsonic(c, newSubsonicOK())
}

package web

import (
	"log"
	"strings"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

type cachedAlbumMetadata struct {
	Album   string
	AlbumID string
}

func hydrateSavedSongAlbumMetadata(song *SavedSong, extra map[string]string) map[string]string {
	if song == nil || extraMapAlbum(extra) != "" {
		return extra
	}
	updated, changed := hydrateAlbumMetadataFromSearchCache(song.Source, song.SongID, extra)
	if !changed || song.ID == 0 {
		return updated
	}
	writeSavedSongExtra(song.ID, song.Extra, updated)
	return updated
}

func hydratePlayHistoryAlbumMetadata(row *playHistoryRow, extra map[string]string) map[string]string {
	if row == nil || extraMapAlbum(extra) != "" {
		return extra
	}
	updated, changed := hydrateAlbumMetadataFromSearchCache(row.Source, row.SongID, extra)
	if !changed || row.ID == 0 {
		return updated
	}
	writePlayHistoryExtra(row.ID, row.Extra, updated)
	return updated
}

// hydrateAlbumMetadataFromSearchCache 用搜索结果缓存里已有的专辑元数据补全 extra。
// 查询走进程内的搜索结果专辑索引(search_album_index.go)的 O(1) 查找,
// 不再对每首缺 album 的歌发一次全表 LIKE。
func hydrateAlbumMetadataFromSearchCache(source, songID string, extra map[string]string) (map[string]string, bool) {
	meta, ok := lookupAlbumMetadataInSearchCache(source, songID)
	if !ok || meta.Album == "" {
		return extra, false
	}
	if extra == nil {
		extra = map[string]string{}
	}
	changed := false
	if strings.TrimSpace(extra["album"]) == "" {
		extra["album"] = meta.Album
		changed = true
	}
	if meta.AlbumID != "" && strings.TrimSpace(extra["album_id"]) == "" {
		extra["album_id"] = meta.AlbumID
		changed = true
	}
	return extra, changed
}

func findAlbumMetadataInSongs(songs []model.Track, source, songID string) (cachedAlbumMetadata, bool) {
	for _, song := range songs {
		if strings.TrimSpace(song.Source) != source || strings.TrimSpace(song.ID) != songID {
			continue
		}
		if meta, ok := albumMetadataFromTrack(song); ok {
			return meta, true
		}
	}
	return cachedAlbumMetadata{}, false
}

// albumMetadataFromTrack 从一首歌里取专辑名/专辑 ID(含 extra 里的别名键)。
// 没有专辑名的歌不算命中 —— 与改造前 findAlbumMetadataInSongs 的 continue 语义一致。
func albumMetadataFromTrack(song model.Track) (cachedAlbumMetadata, bool) {
	album := strings.TrimSpace(song.Album)
	if album == "" {
		album = extraMapAlbum(song.Extra)
	}
	if album == "" {
		return cachedAlbumMetadata{}, false
	}
	albumID := strings.TrimSpace(song.AlbumID)
	if albumID == "" {
		albumID = extraMapAlbumID(song.Extra)
	}
	return cachedAlbumMetadata{Album: album, AlbumID: albumID}, true
}

// writeSavedSongExtra / writePlayHistoryExtra 都是"元数据补全"的后台写:
// 失败不影响本次请求的返回(用户仍看到歌单/历史),所以不向上传播错误 ——
// 但必须留一条日志(2026-11 全库扫描修正:原来用 `_ =` 完全静默)。
//
// 为什么值得记:这两个写一旦持续失败(表结构变更、磁盘满、权限),症状是
// "专辑信息永远补不上",而日志里什么都没有 —— 只能靠猜。
func writeSavedSongExtra(id uint, oldRaw string, extra map[string]string) {
	raw := encodeSongExtraWithMetadata(extra, extraMapAlbum(extra), extraMapAlbumID(extra))
	if db == nil || raw == "" || raw == oldRaw {
		return
	}
	if err := db.Model(&SavedSong{}).Where("id = ?", id).Update("extra", raw).Error; err != nil {
		log.Printf("[album-meta] 回写 saved_song extra 失败 id=%d: %v", id, err)
	}
}

func writePlayHistoryExtra(id uint, oldRaw string, extra map[string]string) {
	raw := encodeSongExtraWithMetadata(extra, extraMapAlbum(extra), extraMapAlbumID(extra))
	if db == nil || raw == "" || raw == oldRaw {
		return
	}
	if err := db.Model(&playHistoryRow{}).Where("id = ?", id).Update("extra", raw).Error; err != nil {
		log.Printf("[album-meta] 回写 play_history extra 失败 id=%d: %v", id, err)
	}
}

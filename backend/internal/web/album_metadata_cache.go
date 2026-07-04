package web

import (
	"encoding/json"
	"strings"

	"github.com/guohuiyuan/music-lib/model"
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

func lookupAlbumMetadataInSearchCache(source, songID string) (cachedAlbumMetadata, bool) {
	source = strings.TrimSpace(source)
	songID = strings.TrimSpace(songID)
	if db == nil || source == "" || songID == "" {
		return cachedAlbumMetadata{}, false
	}

	encodedID, err := json.Marshal(songID)
	if err != nil {
		return cachedAlbumMetadata{}, false
	}
	pattern := "%\"id\":" + string(encodedID) + "%"

	var rows []searchCacheRow
	if err := db.Where("payload LIKE ?", pattern).Limit(25).Find(&rows).Error; err != nil {
		return cachedAlbumMetadata{}, false
	}
	for _, row := range rows {
		var resp jsonSearchResponse
		if err := json.Unmarshal([]byte(row.Payload), &resp); err != nil {
			continue
		}
		if meta, ok := findAlbumMetadataInSongs(resp.Songs, source, songID); ok {
			return meta, true
		}
	}
	return cachedAlbumMetadata{}, false
}

func findAlbumMetadataInSongs(songs []model.Song, source, songID string) (cachedAlbumMetadata, bool) {
	for _, song := range songs {
		if strings.TrimSpace(song.Source) != source || strings.TrimSpace(song.ID) != songID {
			continue
		}
		album := strings.TrimSpace(song.Album)
		if album == "" {
			album = extraMapAlbum(song.Extra)
		}
		if album == "" {
			continue
		}
		albumID := strings.TrimSpace(song.AlbumID)
		if albumID == "" {
			albumID = extraMapAlbumID(song.Extra)
		}
		return cachedAlbumMetadata{Album: album, AlbumID: albumID}, true
	}
	return cachedAlbumMetadata{}, false
}

func writeSavedSongExtra(id uint, oldRaw string, extra map[string]string) {
	raw := encodeSongExtraWithMetadata(extra, extraMapAlbum(extra), extraMapAlbumID(extra))
	if db == nil || raw == "" || raw == oldRaw {
		return
	}
	_ = db.Model(&SavedSong{}).Where("id = ?", id).Update("extra", raw).Error
}

func writePlayHistoryExtra(id uint, oldRaw string, extra map[string]string) {
	raw := encodeSongExtraWithMetadata(extra, extraMapAlbum(extra), extraMapAlbumID(extra))
	if db == nil || raw == "" || raw == oldRaw {
		return
	}
	_ = db.Model(&playHistoryRow{}).Where("id = ?", id).Update("extra", raw).Error
}

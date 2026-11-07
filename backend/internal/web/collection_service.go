package web

import (
	"errors"
	"fmt"
	"strings"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func loadCollectionSongs(collection *Collection) ([]model.Track, error) {
	if collection == nil {
		return nil, errors.New("collection is nil")
	}
	if collection.isImported() {
		return loadImportedCollectionSongs(collection)
	}
	return loadSavedSongs(collection.ID)
}

func loadSavedSongs(collectionID uint) ([]model.Track, error) {
	var rows []SavedSong
	if err := db.Where("collection_id = ?", collectionID).Order("id DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	tracks := make([]model.Track, 0, len(rows))
	for index := range rows {
		row := &rows[index]
		extra := hydrateSavedSongAlbumMetadata(row, decodeSongExtraMap(row.Extra))
		tracks = append(tracks, model.Track{
			ID: row.SongID, Source: row.Source, Name: row.Name, Artist: row.Artist,
			Album: extraMapAlbum(extra), AlbumID: extraMapAlbumID(extra),
			Link: extraMapValue(extra, "link"), Cover: row.Cover,
			Duration: row.Duration, Extra: extra,
		})
	}
	return tracks, nil
}

func saveSongToManualCollection(collectionID uint, song model.Track) (bool, error) {
	return saveSongWithDB(db, collectionID, song)
}

func saveSongWithDB(connection *gorm.DB, collectionID uint, song model.Track) (bool, error) {
	song.ID = strings.TrimSpace(song.ID)
	song.Source = strings.TrimSpace(song.Source)
	if song.ID == "" || song.Source == "" {
		return false, errors.New("missing song id or source")
	}
	row := SavedSong{
		CollectionID: collectionID, SongID: song.ID, Source: song.Source,
		Extra: encodeSongExtraWithMetadata(song.Extra, song.Album, song.AlbumID),
		Name:  song.Name, Artist: song.Artist, Cover: song.Cover, Duration: song.Duration,
	}
	result := connection.Clauses(clause.OnConflict{DoNothing: true}).Create(&row)
	return result.RowsAffected > 0, result.Error
}

func saveSongsToManualCollection(collectionID uint, songs []model.Track) (int, error) {
	added := 0
	err := db.Transaction(func(tx *gorm.DB) error {
		for _, song := range songs {
			created, err := saveSongWithDB(tx, collectionID, song)
			if err != nil {
				return err
			}
			if created {
				added++
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return added, nil
}

func loadImportedCollectionSongs(collection *Collection) ([]model.Track, error) {
	if collection == nil || !collection.isImported() {
		return nil, errors.New("collection is not imported")
	}
	source := collection.normalizedSource()
	if source == "" {
		return nil, errors.New("missing imported source")
	}
	externalID := strings.TrimSpace(collection.ExternalID)
	link := collection.originalLink()
	contentType := collection.normalizedContentType()

	var attempts []error
	try := func(fetch func() ([]model.Track, error)) ([]model.Track, bool) {
		tracks, err := fetch()
		if err != nil {
			attempts = append(attempts, err)
			return nil, false
		}
		if len(tracks) == 0 {
			attempts = append(attempts, errors.New("provider returned no songs"))
			return nil, false
		}
		return ensureSongSource(tracks, source), true
	}

	if contentType == collectionContentAlbum {
		if externalID != "" {
			if detail := albumDetailFuncProvider(source); detail != nil {
				if tracks, ok := try(func() ([]model.Track, error) { return detail(externalID) }); ok {
					return tracks, nil
				}
			}
		}
		if link != "" {
			if parse := parseAlbumFuncProvider(source); parse != nil {
				if tracks, ok := try(func() ([]model.Track, error) {
					_, tracks, err := parse(link)
					return tracks, err
				}); ok {
					return tracks, nil
				}
			}
		}
	} else {
		if externalID != "" {
			if detail := playlistDetailFuncProvider(source); detail != nil {
				if tracks, ok := try(func() ([]model.Track, error) { return detail(externalID) }); ok {
					return tracks, nil
				}
			}
		}
		if link != "" {
			if parse := parsePlaylistFuncProvider(source); parse != nil {
				if tracks, ok := try(func() ([]model.Track, error) {
					_, tracks, err := parse(link)
					return tracks, err
				}); ok {
					return tracks, nil
				}
			}
		}
	}
	if len(attempts) > 0 {
		return nil, fmt.Errorf("failed to fetch imported %s songs: %w", contentType, errors.Join(attempts...))
	}
	return nil, fmt.Errorf("failed to fetch imported %s songs", contentType)
}

func collectionSongsJSON(collection *Collection) ([]gin.H, error) {
	if collection == nil {
		return nil, errors.New("collection is nil")
	}
	if collection.isImported() {
		tracks, err := loadImportedCollectionSongs(collection)
		if err != nil {
			return nil, err
		}
		warmQualityCache(tracks, 6)
		// 导入歌单是**活数据**(每次打开都实时从平台拉), 平台的返回里同样没有副歌字段,
		// 所以这里也要补 —— 否则从平台导入的歌单永远看不到标记。
		chorusPoints := fillChorusForTracks(trackChorusIdentities(tracks))
		response := make([]gin.H, 0, len(tracks))
		for _, track := range tracks {
			if point, ok := chorusPoints[chorusSourceKey(track.Source, track.ID)]; ok && point.Valid() {
				if track.Extra == nil {
					track.Extra = make(map[string]string, 2)
				}
				applyChorusToExtraMap(track.Extra, point)
			}
			response = append(response, remoteCollectionSongJSON(collection.ID, track))
		}
		return response, nil
	}

	var rows []SavedSong
	if err := db.Where("collection_id = ?", collection.ID).Order("id DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	response := make([]gin.H, 0, len(rows))
	warmTracks := make([]model.Track, 0, len(rows))
	// 副歌点位在读取时补(2026-11): saved_songs.extra 存的是"加歌当时"的快照, 那时
	// 还没有 chorus_* 字段。不回填的话, 用户从歌单点开一首网易歌也看不到副歌标记 ——
	// 和「最近播放」是同一个根因, 只是表不同。
	// 只处理这一页(歌单可能有几百首), 且走统一限流路径(网易批量、酷我串行 ≤5)。
	identities := make([]chorusIdentity, 0, len(rows))
	for index := range rows {
		row := &rows[index]
		identities = append(identities, chorusIdentity{
			Source: row.Source, SongID: row.SongID, Name: row.Name, Artist: row.Artist,
		})
	}
	chorusPoints := fillChorusForTracks(identities)
	for index := range rows {
		row := &rows[index]
		extra := hydrateSavedSongAlbumMetadata(row, decodeSongExtraMap(row.Extra))
		if point, ok := chorusPoints[chorusSourceKey(row.Source, row.SongID)]; ok && point.Valid() {
			applyChorusToExtraMap(extra, point)
		}
		// 必须带上 Name/Artist: 只给 ID/Source 会让下游的取址兜底词退化成纯数字
		// 歌曲 ID(见 core.resolveProviderSong)。网易上那等于用一串数字去搜歌名 ——
		// 既搜不到目标曲, 又是对上游搜索接口的额外爆破, 会直接把自己打成限流
		// (2026-11 真实事故: 79 次纯数字搜索后网易全域 405,「腐草为萤」播放 502)。
		// Name/Artist 是这里唯一可靠的取址兜底词来源, 下游没有别处能补回来。
		warmTracks = append(warmTracks, model.Track{
			ID: row.SongID, Source: row.Source, Name: row.Name, Artist: row.Artist,
			Duration: row.Duration, Extra: extra,
		})
		response = append(response, savedCollectionSongJSON(*row, extra))
	}
	warmQualityCache(warmTracks, 6)
	return response, nil
}

func remoteCollectionSongJSON(collectionID uint, track model.Track) gin.H {
	return gin.H{
		"collection_id": collectionID, "id": track.ID, "source": track.Source,
		"extra": track.Extra, "name": track.Name, "artist": track.Artist,
		"album": track.Album, "album_id": track.AlbumID, "cover": track.Cover,
		"duration": track.Duration, "link": track.Link,
	}
}

func savedCollectionSongJSON(row SavedSong, extra map[string]string) gin.H {
	return gin.H{
		"db_id": row.ID, "collection_id": row.CollectionID,
		"id": row.SongID, "source": row.Source,
		"extra": decodeSongExtraObject(row.Extra), "name": row.Name, "artist": row.Artist,
		"album": extraMapAlbum(extra), "album_id": extraMapAlbumID(extra),
		"cover": row.Cover, "duration": row.Duration,
		"link": extraMapValue(extra, "link"), "added_at": row.AddedAt,
	}
}

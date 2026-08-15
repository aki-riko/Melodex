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
		response := make([]gin.H, 0, len(tracks))
		for _, track := range tracks {
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
	for index := range rows {
		row := &rows[index]
		extra := hydrateSavedSongAlbumMetadata(row, decodeSongExtraMap(row.Extra))
		warmTracks = append(warmTracks, model.Track{
			ID: row.SongID, Source: row.Source, Duration: row.Duration, Extra: extra,
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

package web

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

const (
	legacyFavoritesDBFile = "data/favorites.db"

	collectionKindManual   = "manual"
	collectionKindImported = "imported"
	collectionKindFavorite = "favorite"
	favoriteCollectionName = "我喜欢"

	collectionContentPlaylist = "playlist"
	collectionContentAlbum    = "album"
)

var (
	playlistDetailFuncProvider = core.GetPlaylistDetailFunc
	albumDetailFuncProvider    = core.GetAlbumDetailFunc
	parsePlaylistFuncProvider  = core.GetParsePlaylistFunc
	parseAlbumFuncProvider     = core.GetParseAlbumFunc

	userPlaylistsFuncProvider     = core.GetUserPlaylistsFunc
	userPlaylistSourceNamesGetter = core.GetUserPlaylistSourceNames
)

type Collection struct {
	ID          uint        `gorm:"primaryKey" json:"id"`
	UserID      uint        `gorm:"index;not null;default:0" json:"user_id"`
	Name        string      `gorm:"not null" json:"name"`
	Description string      `json:"description"`
	Cover       string      `json:"cover"`
	Kind        string      `gorm:"not null;default:manual" json:"kind"`
	ContentType string      `gorm:"column:content_type;not null;default:playlist" json:"content_type"`
	Source      string      `gorm:"not null;default:local" json:"source"`
	ExternalID  string      `json:"external_id"`
	Link        string      `json:"link"`
	Creator     string      `json:"creator"`
	TrackCount  int         `json:"track_count"`
	CreatedAt   time.Time   `json:"created_at"`
	SavedSongs  []SavedSong `gorm:"constraint:OnDelete:CASCADE;" json:"-"`
}

type SavedSong struct {
	ID           uint      `gorm:"primaryKey" json:"db_id"`
	CollectionID uint      `gorm:"uniqueIndex:idx_col_song_src" json:"collection_id"`
	SongID       string    `gorm:"uniqueIndex:idx_col_song_src;not null" json:"song_id"`
	Source       string    `gorm:"uniqueIndex:idx_col_song_src;not null" json:"source"`
	Extra        string    `json:"extra"`
	Name         string    `json:"name"`
	Artist       string    `json:"artist"`
	Cover        string    `json:"cover"`
	Duration     int       `json:"duration"`
	AddedAt      time.Time `json:"added_at"`
}

type importCollectionRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Cover       string `json:"cover"`
	Creator     string `json:"creator"`
	TrackCount  int    `json:"track_count"`
	Source      string `json:"source"`
	ExternalID  string `json:"external_id"`
	Link        string `json:"link"`
	ContentType string `json:"content_type"`
	MergeIntoID uint   `json:"merge_into_id"`
}

func (collection Collection) normalizedKind() string {
	switch strings.TrimSpace(collection.Kind) {
	case collectionKindImported:
		return collectionKindImported
	case collectionKindFavorite:
		return collectionKindFavorite
	default:
		return collectionKindManual
	}
}

func (collection Collection) normalizedContentType() string {
	if strings.TrimSpace(collection.ContentType) == collectionContentAlbum {
		return collectionContentAlbum
	}
	return collectionContentPlaylist
}

func (collection Collection) normalizedSource() string {
	source := strings.TrimSpace(collection.Source)
	if source != "" && source != localMusicSource {
		return source
	}
	if collection.isImported() {
		return ""
	}
	return localMusicSource
}

func (collection Collection) isImported() bool {
	return collection.normalizedKind() == collectionKindImported
}

func (collection Collection) originalLink() string {
	if link := strings.TrimSpace(collection.Link); link != "" {
		return link
	}
	if !collection.isImported() || collection.normalizedSource() == "" || strings.TrimSpace(collection.ExternalID) == "" {
		return ""
	}
	return core.GetOriginalLink(collection.normalizedSource(), collection.ExternalID, collection.normalizedContentType())
}

var albumExtraKeys = []string{
	"album", "Album", "album_name", "albumName", "AlbumName", "albumname",
	"album_title", "albumTitle", "AlbumTitle",
}

var albumIDExtraKeys = []string{
	"album_id", "AlbumID", "albumID", "albumId", "album_mid", "albumMid",
	"albumMID", "AlbumMid", "AlbumMID", "albummid", "albumid",
}

func decodeSongExtraMap(raw string) map[string]string {
	var object map[string]interface{}
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	if err := json.Unmarshal([]byte(raw), &object); err != nil {
		log.Printf("[collection] decode song extra: %v", err)
		return nil
	}
	result := make(map[string]string, len(object))
	for key, value := range object {
		switch typed := value.(type) {
		case string:
			result[key] = typed
		case float64:
			result[key] = fmt.Sprintf("%.0f", typed)
		case bool:
			result[key] = fmt.Sprintf("%t", typed)
		default:
			encoded, err := json.Marshal(typed)
			if err != nil {
				log.Printf("[collection] encode extra field %q: %v", key, err)
				continue
			}
			result[key] = string(encoded)
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func extraMapValue(extra map[string]string, key string) string {
	return strings.TrimSpace(extra[key])
}

func extraMapFirstValue(extra map[string]string, keys ...string) string {
	for _, key := range keys {
		if value := extraMapValue(extra, key); value != "" {
			return value
		}
	}
	return ""
}

func extraMapAlbum(extra map[string]string) string {
	return extraMapFirstValue(extra, albumExtraKeys...)
}

func extraMapAlbumID(extra map[string]string) string {
	return extraMapFirstValue(extra, albumIDExtraKeys...)
}

func encodeSongExtraWithMetadata(extra interface{}, album, albumID string) string {
	object := normalizeExtraObject(extra)
	album = firstNonEmpty(strings.TrimSpace(album), extraObjectFirstValue(object, albumExtraKeys...))
	albumID = firstNonEmpty(strings.TrimSpace(albumID), extraObjectFirstValue(object, albumIDExtraKeys...))
	setExtraObjectDefault(object, "album", album)
	setExtraObjectDefault(object, "album_id", albumID)
	if len(object) == 0 {
		return ""
	}
	encoded, err := json.Marshal(object)
	if err != nil {
		log.Printf("[collection] encode song extra: %v", err)
		return ""
	}
	return string(encoded)
}

func normalizeExtraObject(extra interface{}) map[string]interface{} {
	result := make(map[string]interface{})
	switch value := extra.(type) {
	case nil:
		return result
	case map[string]interface{}:
		for key, item := range value {
			result[key] = item
		}
		return result
	case map[string]string:
		for key, item := range value {
			result[key] = item
		}
		return result
	case string:
		if raw := strings.TrimSpace(value); raw != "" && raw != "{}" && raw != "null" {
			if err := json.Unmarshal([]byte(raw), &result); err != nil {
				log.Printf("[collection] normalize string extra: %v", err)
			}
		}
		return result
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			log.Printf("[collection] normalize extra value: %v", err)
			return result
		}
		if err := json.Unmarshal(encoded, &result); err != nil {
			log.Printf("[collection] normalize encoded extra: %v", err)
		}
		return result
	}
}

func extraObjectFirstValue(extra map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		value, ok := extra[key]
		if !ok || value == nil {
			continue
		}
		if text := strings.TrimSpace(fmt.Sprint(value)); text != "" && text != "<nil>" {
			return text
		}
	}
	return ""
}

func setExtraObjectDefault(extra map[string]interface{}, key, value string) {
	if value == "" {
		return
	}
	existing, exists := extra[key]
	if !exists || existing == nil || strings.TrimSpace(fmt.Sprint(existing)) == "" {
		extra[key] = value
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func decodeSongExtraObject(raw string) interface{} {
	if raw = strings.TrimSpace(raw); raw == "" {
		return nil
	}
	var value interface{}
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return raw
	}
	return value
}

func buildImportedCollection(request importCollectionRequest) (*Collection, error) {
	request.Name = strings.TrimSpace(request.Name)
	request.Description = strings.TrimSpace(request.Description)
	request.Cover = strings.TrimSpace(request.Cover)
	request.Creator = strings.TrimSpace(request.Creator)
	request.Source = strings.TrimSpace(request.Source)
	request.ExternalID = strings.TrimSpace(request.ExternalID)
	request.Link = strings.TrimSpace(request.Link)
	request.ContentType = strings.TrimSpace(request.ContentType)

	if request.ContentType != collectionContentPlaylist && request.ContentType != collectionContentAlbum {
		return nil, fmt.Errorf("invalid content_type")
	}
	if request.Source == "" || request.Source == localMusicSource {
		return nil, fmt.Errorf("invalid source")
	}
	if request.ExternalID == "" {
		return nil, fmt.Errorf("missing external_id")
	}
	if request.Name == "" {
		if request.ContentType == collectionContentAlbum {
			request.Name = "导入专辑"
		} else {
			request.Name = "导入歌单"
		}
	}
	if request.Link == "" {
		request.Link = core.GetOriginalLink(request.Source, request.ExternalID, request.ContentType)
	}
	return &Collection{
		Name: request.Name, Description: request.Description, Cover: request.Cover,
		Creator: request.Creator, TrackCount: request.TrackCount,
		Kind: collectionKindImported, ContentType: request.ContentType,
		Source: request.Source, ExternalID: request.ExternalID, Link: request.Link,
	}, nil
}

func ensureSongSource(songs []model.Track, source string) []model.Track {
	for index := range songs {
		if strings.TrimSpace(songs[index].Source) == "" {
			songs[index].Source = source
		}
	}
	return songs
}

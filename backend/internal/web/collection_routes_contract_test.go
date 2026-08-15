package web

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

func performCollectionRequest(router http.Handler, method, path string, body []byte) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	router.ServeHTTP(recorder, request)
	return recorder
}

func createManualCollectionForContract(t *testing.T, name string) Collection {
	t.Helper()
	collection := Collection{UserID: testUserID, Name: name, Kind: collectionKindManual, ContentType: collectionContentPlaylist, Source: "local"}
	if err := db.Create(&collection).Error; err != nil {
		t.Fatalf("create manual collection: %v", err)
	}
	return collection
}

func TestCollectionListingAndReferenceImportContract(t *testing.T) {
	initCollectionDBForTest(t)
	manual := createManualCollectionForContract(t, "Manual")
	_ = manual
	imported := Collection{UserID: testUserID, Name: "Imported", Kind: collectionKindImported, ContentType: collectionContentAlbum, Source: "qq", ExternalID: "album-1"}
	if err := db.Create(&imported).Error; err != nil {
		t.Fatalf("seed imported collection: %v", err)
	}
	router := newCollectionTestRouter()

	recorder := performCollectionRequest(router, http.MethodGet, RoutePrefix+"/collections", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("default collection list status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var collections []Collection
	if err := json.Unmarshal(recorder.Body.Bytes(), &collections); err != nil {
		t.Fatalf("decode default collection list: %v", err)
	}
	names := map[string]bool{}
	for _, collection := range collections {
		names[collection.Name] = true
	}
	if !names["Manual"] || !names[favoriteCollectionName] || names["Imported"] {
		t.Fatalf("default collection names = %#v", names)
	}

	recorder = performCollectionRequest(router, http.MethodGet, RoutePrefix+"/collections?include_imported=1", nil)
	if err := json.Unmarshal(recorder.Body.Bytes(), &collections); err != nil || recorder.Code != http.StatusOK || len(collections) != 3 {
		t.Fatalf("complete collection list status/count/error = %d/%d/%v", recorder.Code, len(collections), err)
	}

	request := importCollectionRequest{Name: "QQ 精选", Description: "收藏的外部歌单", Cover: "https://example.com/cover.jpg", Creator: "QQ 音乐", TrackCount: 18, Source: "qq", ExternalID: "playlist-123", ContentType: collectionContentPlaylist}
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("encode reference import: %v", err)
	}
	recorder = performCollectionRequest(router, http.MethodPost, RoutePrefix+"/collections/import", payload)
	if recorder.Code != http.StatusOK {
		t.Fatalf("reference import status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		ID uint `json:"id"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode reference import response: %v", err)
	}
	var stored Collection
	if err := db.First(&stored, response.ID).Error; err != nil {
		t.Fatalf("load imported collection: %v", err)
	}
	if stored.Kind != collectionKindImported || stored.Source != "qq" || stored.ContentType != collectionContentPlaylist || stored.ExternalID != "playlist-123" {
		t.Fatalf("stored imported collection = %#v", stored)
	}
}

func TestCollectionMergeContract(t *testing.T) {
	initCollectionDBForTest(t)
	target := createManualCollectionForContract(t, "同名歌单")
	if err := db.Create(&SavedSong{CollectionID: target.ID, SongID: "song-1", Source: "qq", Name: "Existing Song"}).Error; err != nil {
		t.Fatalf("seed existing track: %v", err)
	}
	previous := playlistDetailFuncProvider
	playlistDetailFuncProvider = func(source string) func(string) ([]model.Track, error) {
		if source != "qq" {
			t.Fatalf("playlist source = %q", source)
		}
		return func(id string) ([]model.Track, error) {
			if id != "playlist-merge" {
				t.Fatalf("playlist ID = %q", id)
			}
			return []model.Track{{ID: "song-1", Source: "qq", Name: "Existing Song", Artist: "Artist A"}, {ID: "song-2", Name: "New Song", Artist: "Artist B", Album: "Album B", AlbumID: "album-b"}}, nil
		}
	}
	t.Cleanup(func() { playlistDetailFuncProvider = previous })
	payload, err := json.Marshal(importCollectionRequest{Name: target.Name, Source: "qq", ExternalID: "playlist-merge", ContentType: collectionContentPlaylist, MergeIntoID: target.ID})
	if err != nil {
		t.Fatalf("encode merge request: %v", err)
	}
	recorder := performCollectionRequest(newCollectionTestRouter(), http.MethodPost, RoutePrefix+"/collections/import", payload)
	if recorder.Code != http.StatusOK {
		t.Fatalf("merge status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		ID     uint `json:"id"`
		Merged bool `json:"merged"`
		Added  int  `json:"added"`
		Total  int  `json:"total"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode merge response: %v", err)
	}
	if response.ID != target.ID || !response.Merged || response.Added != 1 || response.Total != 2 {
		t.Fatalf("merge response = %#v", response)
	}
	var tracks []SavedSong
	if err := db.Where("collection_id = ?", target.ID).Order("song_id ASC").Find(&tracks).Error; err != nil || len(tracks) != 2 {
		t.Fatalf("merged tracks = %#v, err=%v", tracks, err)
	}
	metadata := decodeSongExtraMap(tracks[1].Extra)
	if tracks[1].SongID != "song-2" || tracks[1].Source != "qq" || extraMapAlbum(metadata) != "Album B" || extraMapAlbumID(metadata) != "album-b" {
		t.Fatalf("merged new track = %#v, metadata=%#v", tracks[1], metadata)
	}
	var importedCount int64
	if err := db.Model(&Collection{}).Where("kind = ?", collectionKindImported).Count(&importedCount).Error; err != nil || importedCount != 0 {
		t.Fatalf("unexpected imported records = %d, err=%v", importedCount, err)
	}
}

func TestManualCollectionMetadataContract(t *testing.T) {
	initCollectionDBForTest(t)
	collection := createManualCollectionForContract(t, "Manual Playlist")
	router := newCollectionTestRouter()
	path := fmt.Sprintf("%s/collections/%d/songs", RoutePrefix, collection.ID)
	payload := []byte(`{"id":"song-1","source":"qq","name":"Song One","artist":"Artist A","album":"Album A","album_id":"album-1","extra":{"songmid":"mid-1"}}`)
	recorder := performCollectionRequest(router, http.MethodPost, path, payload)
	if recorder.Code != http.StatusOK {
		t.Fatalf("add track status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var saved SavedSong
	if err := db.Where("collection_id = ? AND song_id = ? AND source = ?", collection.ID, "song-1", "qq").First(&saved).Error; err != nil {
		t.Fatalf("load saved track: %v", err)
	}
	metadata := decodeSongExtraMap(saved.Extra)
	if extraMapAlbum(metadata) != "Album A" || extraMapAlbumID(metadata) != "album-1" {
		t.Fatalf("stored album metadata = %#v", metadata)
	}
	recorder = performCollectionRequest(router, http.MethodGet, path, nil)
	var tracks []map[string]interface{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &tracks); err != nil || recorder.Code != http.StatusOK || len(tracks) != 1 || tracks[0]["album"] != "Album A" || tracks[0]["album_id"] != "album-1" {
		t.Fatalf("track response = %#v, status=%d, err=%v", tracks, recorder.Code, err)
	}
}

func TestCollectionMetadataBackfillContract(t *testing.T) {
	initCollectionDBForTest(t)
	collection := createManualCollectionForContract(t, "Manual Playlist")
	if err := db.Create(&SavedSong{CollectionID: collection.ID, SongID: "song-1", Source: "qq", Name: "Song One", Artist: "Artist A", Extra: `{"songmid":"song-1"}`}).Error; err != nil {
		t.Fatalf("seed saved track: %v", err)
	}
	cachePayload, err := json.Marshal(jsonSearchResponse{Songs: []model.Track{{ID: "song-1", Source: "qq", Name: "Song One", Artist: "Artist A", Album: "Cached Album", AlbumID: "cached-album-1"}}, Type: "song"})
	if err != nil {
		t.Fatalf("encode search cache: %v", err)
	}
	if err := db.Create(&searchCacheRow{Key: "album-cache", Payload: string(cachePayload), CreatedAt: time.Now()}).Error; err != nil {
		t.Fatalf("seed search cache: %v", err)
	}
	response, err := collectionSongsJSON(&collection)
	if err != nil || len(response) != 1 || response[0]["album"] != "Cached Album" || response[0]["album_id"] != "cached-album-1" {
		t.Fatalf("backfilled response = %#v, err=%v", response, err)
	}
	var saved SavedSong
	if err := db.Where("collection_id = ? AND song_id = ?", collection.ID, "song-1").First(&saved).Error; err != nil {
		t.Fatalf("reload backfilled track: %v", err)
	}
	metadata := decodeSongExtraMap(saved.Extra)
	if extraMapAlbum(metadata) != "Cached Album" || extraMapAlbumID(metadata) != "cached-album-1" {
		t.Fatalf("persisted backfill = %#v", metadata)
	}
}

func TestImportedCollectionReadOnlyContract(t *testing.T) {
	initCollectionDBForTest(t)
	collection := Collection{UserID: testUserID, Name: "Imported Playlist", Kind: collectionKindImported, ContentType: collectionContentPlaylist, Source: "qq", ExternalID: "playlist-1", TrackCount: 2}
	if err := db.Create(&collection).Error; err != nil {
		t.Fatalf("create imported collection: %v", err)
	}
	previous := playlistDetailFuncProvider
	playlistDetailFuncProvider = func(source string) func(string) ([]model.Track, error) {
		if source != "qq" {
			t.Fatalf("playlist source = %q", source)
		}
		return func(id string) ([]model.Track, error) {
			if id != "playlist-1" {
				t.Fatalf("playlist ID = %q", id)
			}
			return []model.Track{{ID: "song-1", Source: "qq", Name: "Song One", Artist: "Artist A"}, {ID: "song-2", Source: "qq", Name: "Song Two", Artist: "Artist B"}}, nil
		}
	}
	t.Cleanup(func() { playlistDetailFuncProvider = previous })
	router := newCollectionTestRouter()
	path := fmt.Sprintf("%s/collections/%d/songs", RoutePrefix, collection.ID)
	recorder := performCollectionRequest(router, http.MethodGet, path, nil)
	var tracks []map[string]interface{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &tracks); err != nil || recorder.Code != http.StatusOK || len(tracks) != 2 || tracks[0]["id"] != "song-1" {
		t.Fatalf("live imported tracks = %#v, status=%d, err=%v", tracks, recorder.Code, err)
	}
	for _, request := range []struct {
		method, path string
		body         []byte
	}{
		{http.MethodPost, path, []byte(`{"id":"song-1","source":"qq","name":"Song One"}`)},
		{http.MethodDelete, path + "?id=song-1&source=qq", nil},
	} {
		recorder = performCollectionRequest(router, request.method, request.path, request.body)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s imported mutation status = %d", request.method, recorder.Code)
		}
	}
}

func TestManualCollectionBatchDeleteContract(t *testing.T) {
	initCollectionDBForTest(t)
	collection := createManualCollectionForContract(t, "Manual Playlist")
	seedBatchDeleteTracks(t, collection.ID)
	path := fmt.Sprintf("%s/collections/%d/songs", RoutePrefix, collection.ID)
	requestBody := encodeBatchDeleteContractBody(t, [][2]string{{"song-1", "qq"}, {"song-2", localMusicSource}})
	recorder := performCollectionRequest(newCollectionTestRouter(), http.MethodDelete, path, requestBody)
	if recorder.Code != http.StatusOK {
		t.Fatalf("batch delete status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	remaining, err := batchDeleteRemainingSongIDs(collection.ID)
	if err != nil || len(remaining) != 1 || remaining[0] != "song-3" {
		t.Fatalf("remaining track IDs = %#v, err=%v", remaining, err)
	}
}

func seedBatchDeleteTracks(t *testing.T, collectionID uint) {
	t.Helper()
	fixtures := [][3]string{
		{"song-1", "qq", "Song One"},
		{"song-2", localMusicSource, "Song Two"},
		{"song-3", "netease", "Song Three"},
	}
	for _, fixture := range fixtures {
		track := SavedSong{CollectionID: collectionID}
		track.SongID, track.Source, track.Name = fixture[0], fixture[1], fixture[2]
		if err := db.Create(&track).Error; err != nil {
			t.Fatalf("seed batch-delete track %s: %v", track.SongID, err)
		}
	}
}

func encodeBatchDeleteContractBody(t *testing.T, identities [][2]string) []byte {
	t.Helper()
	type identity struct {
		ID     string `json:"id"`
		Source string `json:"source"`
	}
	payload := struct {
		Songs []identity `json:"songs"`
	}{Songs: make([]identity, 0, len(identities))}
	for _, item := range identities {
		payload.Songs = append(payload.Songs, identity{ID: item[0], Source: item[1]})
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode batch delete body: %v", err)
	}
	return encoded
}

func batchDeleteRemainingSongIDs(collectionID uint) ([]string, error) {
	var tracks []SavedSong
	result := db.Where("collection_id = ?", collectionID).Order("song_id ASC").Find(&tracks)
	identities := make([]string, 0, len(tracks))
	for _, track := range tracks {
		identities = append(identities, track.SongID)
	}
	return identities, result.Error
}

func TestImportedCollectionParserFallbackContract(t *testing.T) {
	previousDetail := playlistDetailFuncProvider
	previousParse := parsePlaylistFuncProvider
	playlistDetailFuncProvider = func(string) func(string) ([]model.Track, error) { return nil }
	parsePlaylistFuncProvider = func(source string) func(string) (*model.RemoteCollection, []model.Track, error) {
		if source != "qq" {
			t.Fatalf("parse source = %q", source)
		}
		return func(link string) (*model.RemoteCollection, []model.Track, error) {
			if link != "https://example.com/playlist/1" {
				t.Fatalf("parse link = %q", link)
			}
			return &model.RemoteCollection{ID: "playlist-1"}, []model.Track{{ID: "song-parse", Name: "Parsed Song", Artist: "Parser"}}, nil
		}
	}
	t.Cleanup(func() {
		playlistDetailFuncProvider = previousDetail
		parsePlaylistFuncProvider = previousParse
	})
	tracks, err := loadImportedCollectionSongs(&Collection{Kind: collectionKindImported, ContentType: collectionContentPlaylist, Source: "qq", ExternalID: "playlist-1", Link: "https://example.com/playlist/1"})
	if err != nil || len(tracks) != 1 || tracks[0].ID != "song-parse" || tracks[0].Source != "qq" {
		t.Fatalf("parser fallback tracks = %#v, err=%v", tracks, err)
	}
}

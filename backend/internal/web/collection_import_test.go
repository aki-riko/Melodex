package web

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/guohuiyuan/music-lib/model"
)

// testUserID 是测试 router 注入的当前用户 id(在 initCollectionDBForTest 中创建)。
var testUserID uint

func initCollectionDBForTest(t *testing.T) {
	t.Helper()

	baseDir := t.TempDir()
	settingsDB := filepath.Join(baseDir, "data", "settings.db")
	legacyDB := filepath.Join(baseDir, "data", "favorites.db")

	t.Setenv("MUSIC_DL_CONFIG_DB", settingsDB)
	t.Setenv("MUSIC_DL_FAVORITES_DB", legacyDB)
	t.Setenv("MUSIC_DL_COOKIE_FILE", filepath.Join(baseDir, "data", "cookies.json"))
	resetCollectionStateForTest()
	t.Cleanup(resetCollectionStateForTest)

	InitDB()

	u, err := createUser("tester", "testerpass1", RoleAdmin)
	if err != nil {
		t.Fatalf("create test user: %v", err)
	}
	testUserID = u.ID
}

// withTestUser 注入固定测试用户(模拟已登录管理员),供数据隔离路由在测试中拿到 user_id。
// 用管理员角色:本地库列表/删除测试验证扫描机制(管理员看全部),而歌单查询仍按 user_id
// 过滤(管理员不绕过歌单归属),两类测试都成立。
func withTestUser() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(ctxUserID, testUserID)
		c.Set(ctxUserRole, RoleAdmin)
		c.Set(ctxUsername, "tester")
		c.Next()
	}
}

func newCollectionTestRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	grp := r.Group(RoutePrefix)
	grp.Use(withTestUser())
	RegisterCollectionRoutes(grp)
	return r
}

func TestCollectionsEndpointDefaultsToManualCollections(t *testing.T) {
	initCollectionDBForTest(t)

	manual := Collection{UserID: testUserID, Name: "Manual", Kind: collectionKindManual, ContentType: collectionContentPlaylist, Source: "local"}
	imported := Collection{UserID: testUserID, Name: "Imported", Kind: collectionKindImported, ContentType: collectionContentAlbum, Source: "qq", ExternalID: "album-1"}
	if err := db.Create(&manual).Error; err != nil {
		t.Fatalf("create manual collection: %v", err)
	}
	if err := db.Create(&imported).Error; err != nil {
		t.Fatalf("create imported collection: %v", err)
	}

	router := newCollectionTestRouter()

	req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/collections", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /collections status = %d, want %d", rec.Code, http.StatusOK)
	}

	var collections []Collection
	if err := json.Unmarshal(rec.Body.Bytes(), &collections); err != nil {
		t.Fatalf("decode manual collections: %v", err)
	}
	// 默认视图:自建 Manual + 自动创建的「我喜欢」(favorite),不含 imported。
	names := map[string]bool{}
	for _, c := range collections {
		names[c.Name] = true
	}
	if !names["Manual"] || !names[favoriteCollectionName] {
		t.Fatalf("default view should contain Manual + 我喜欢, got %v", names)
	}
	if names["Imported"] {
		t.Fatalf("default view should not contain imported collection")
	}

	req = httptest.NewRequest(http.MethodGet, RoutePrefix+"/collections?include_imported=1", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /collections?include_imported=1 status = %d, want %d", rec.Code, http.StatusOK)
	}

	if err := json.Unmarshal(rec.Body.Bytes(), &collections); err != nil {
		t.Fatalf("decode all collections: %v", err)
	}
	// 全部:Manual + Imported + 我喜欢 = 3。
	if len(collections) != 3 {
		t.Fatalf("all collections len = %d, want 3", len(collections))
	}
}

func TestImportCollectionEndpointCreatesImportedRecord(t *testing.T) {
	initCollectionDBForTest(t)
	router := newCollectionTestRouter()

	body, err := json.Marshal(importCollectionRequest{
		Name:        "QQ 精选",
		Description: "收藏的外部歌单",
		Cover:       "https://example.com/cover.jpg",
		Creator:     "QQ 音乐",
		TrackCount:  18,
		Source:      "qq",
		ExternalID:  "playlist-123",
		ContentType: collectionContentPlaylist,
	})
	if err != nil {
		t.Fatalf("marshal import request: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, RoutePrefix+"/collections/import", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("POST /collections/import status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var resp struct {
		ID uint `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode import response: %v", err)
	}

	var collection Collection
	if err := db.First(&collection, resp.ID).Error; err != nil {
		t.Fatalf("query imported collection: %v", err)
	}

	if collection.Kind != collectionKindImported {
		t.Fatalf("collection.Kind = %q, want %q", collection.Kind, collectionKindImported)
	}
	if collection.Source != "qq" {
		t.Fatalf("collection.Source = %q, want qq", collection.Source)
	}
	if collection.ContentType != collectionContentPlaylist {
		t.Fatalf("collection.ContentType = %q, want %q", collection.ContentType, collectionContentPlaylist)
	}
	if collection.ExternalID != "playlist-123" {
		t.Fatalf("collection.ExternalID = %q, want playlist-123", collection.ExternalID)
	}
}

func TestImportCollectionEndpointMergesIntoManualCollection(t *testing.T) {
	initCollectionDBForTest(t)

	target := Collection{
		UserID:      testUserID,
		Name:        "同名歌单",
		Kind:        collectionKindManual,
		ContentType: collectionContentPlaylist,
		Source:      "local",
	}
	if err := db.Create(&target).Error; err != nil {
		t.Fatalf("create target collection: %v", err)
	}
	if err := db.Create(&SavedSong{
		CollectionID: target.ID,
		SongID:       "song-1",
		Source:       "qq",
		Name:         "Existing Song",
	}).Error; err != nil {
		t.Fatalf("create existing saved song: %v", err)
	}

	origPlaylistDetail := playlistDetailFuncProvider
	playlistDetailFuncProvider = func(source string) func(string) ([]model.Song, error) {
		if source != "qq" {
			t.Fatalf("playlist detail source = %q, want qq", source)
		}
		return func(id string) ([]model.Song, error) {
			if id != "playlist-merge" {
				t.Fatalf("playlist detail id = %q, want playlist-merge", id)
			}
			return []model.Song{
				{ID: "song-1", Source: "qq", Name: "Existing Song", Artist: "Artist A"},
				{ID: "song-2", Name: "New Song", Artist: "Artist B", Album: "Album B", AlbumID: "album-b"},
			}, nil
		}
	}
	t.Cleanup(func() {
		playlistDetailFuncProvider = origPlaylistDetail
	})

	router := newCollectionTestRouter()
	body, err := json.Marshal(importCollectionRequest{
		Name:        "同名歌单",
		Source:      "qq",
		ExternalID:  "playlist-merge",
		ContentType: collectionContentPlaylist,
		MergeIntoID: target.ID,
	})
	if err != nil {
		t.Fatalf("marshal merge import request: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, RoutePrefix+"/collections/import", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("POST /collections/import merge status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var resp struct {
		ID     uint `json:"id"`
		Merged bool `json:"merged"`
		Added  int  `json:"added"`
		Total  int  `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode merge response: %v", err)
	}
	if resp.ID != target.ID || !resp.Merged || resp.Added != 1 || resp.Total != 2 {
		t.Fatalf("merge response = %+v, want target id/merged/added=1/total=2", resp)
	}

	var saved []SavedSong
	if err := db.Where("collection_id = ?", target.ID).Order("song_id ASC").Find(&saved).Error; err != nil {
		t.Fatalf("query merged songs: %v", err)
	}
	if len(saved) != 2 {
		t.Fatalf("saved songs len = %d, want 2", len(saved))
	}
	if saved[1].SongID != "song-2" || saved[1].Source != "qq" {
		t.Fatalf("new merged song = %+v, want song-2 from qq", saved[1])
	}
	extra := decodeSongExtraMap(saved[1].Extra)
	if extraMapAlbum(extra) != "Album B" || extraMapAlbumID(extra) != "album-b" {
		t.Fatalf("merged song extra = %#v, want album metadata", extra)
	}

	var importedCount int64
	if err := db.Model(&Collection{}).Where("kind = ?", collectionKindImported).Count(&importedCount).Error; err != nil {
		t.Fatalf("count imported collections: %v", err)
	}
	if importedCount != 0 {
		t.Fatalf("imported collection count = %d, want 0", importedCount)
	}
}

func TestManualCollectionAddSongPreservesAlbumMetadata(t *testing.T) {
	initCollectionDBForTest(t)

	collection := Collection{
		UserID:      testUserID,
		Name:        "Manual Playlist",
		Kind:        collectionKindManual,
		ContentType: collectionContentPlaylist,
		Source:      "local",
	}
	if err := db.Create(&collection).Error; err != nil {
		t.Fatalf("create manual collection: %v", err)
	}

	router := newCollectionTestRouter()
	songsPath := fmt.Sprintf("%s/collections/%d/songs", RoutePrefix, collection.ID)
	body := bytes.NewBufferString(`{"id":"song-1","source":"qq","name":"Song One","artist":"Artist A","album":"Album A","album_id":"album-1","extra":{"songmid":"mid-1"}}`)
	req := httptest.NewRequest(http.MethodPost, songsPath, body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST %s status = %d, want %d, body=%s", songsPath, rec.Code, http.StatusOK, rec.Body.String())
	}

	var saved SavedSong
	if err := db.Where("collection_id = ? AND song_id = ? AND source = ?", collection.ID, "song-1", "qq").First(&saved).Error; err != nil {
		t.Fatalf("query saved song: %v", err)
	}
	extra := decodeSongExtraMap(saved.Extra)
	if extraMapAlbum(extra) != "Album A" || extraMapAlbumID(extra) != "album-1" {
		t.Fatalf("saved album metadata = %#v, want Album A/album-1", extra)
	}

	req = httptest.NewRequest(http.MethodGet, songsPath, nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s status = %d, want %d, body=%s", songsPath, rec.Code, http.StatusOK, rec.Body.String())
	}
	var songs []map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &songs); err != nil {
		t.Fatalf("decode songs: %v", err)
	}
	if len(songs) != 1 || songs[0]["album"] != "Album A" || songs[0]["album_id"] != "album-1" {
		t.Fatalf("response songs = %#v, want album metadata", songs)
	}
}

func TestManualCollectionSongsBackfillAlbumFromSearchCache(t *testing.T) {
	initCollectionDBForTest(t)

	collection := Collection{
		UserID:      testUserID,
		Name:        "Manual Playlist",
		Kind:        collectionKindManual,
		ContentType: collectionContentPlaylist,
		Source:      "local",
	}
	if err := db.Create(&collection).Error; err != nil {
		t.Fatalf("create manual collection: %v", err)
	}
	if err := db.Create(&SavedSong{
		CollectionID: collection.ID,
		SongID:       "song-1",
		Source:       "qq",
		Name:         "Song One",
		Artist:       "Artist A",
		Extra:        `{"songmid":"song-1"}`,
	}).Error; err != nil {
		t.Fatalf("create saved song: %v", err)
	}
	payload, err := json.Marshal(jsonSearchResponse{
		Songs: []model.Song{{
			ID:      "song-1",
			Source:  "qq",
			Name:    "Song One",
			Artist:  "Artist A",
			Album:   "Cached Album",
			AlbumID: "cached-album-1",
		}},
		Type: "song",
	})
	if err != nil {
		t.Fatalf("marshal cache payload: %v", err)
	}
	if err := db.Create(&searchCacheRow{Key: "album-cache", Payload: string(payload), CreatedAt: time.Now()}).Error; err != nil {
		t.Fatalf("create search cache: %v", err)
	}

	resp, err := collectionSongsJSON(&collection)
	if err != nil {
		t.Fatalf("collectionSongsJSON: %v", err)
	}
	if len(resp) != 1 || resp[0]["album"] != "Cached Album" || resp[0]["album_id"] != "cached-album-1" {
		t.Fatalf("response songs = %#v, want cached album metadata", resp)
	}

	var saved SavedSong
	if err := db.Where("collection_id = ? AND song_id = ?", collection.ID, "song-1").First(&saved).Error; err != nil {
		t.Fatalf("reload saved song: %v", err)
	}
	extra := decodeSongExtraMap(saved.Extra)
	if extraMapAlbum(extra) != "Cached Album" || extraMapAlbumID(extra) != "cached-album-1" {
		t.Fatalf("saved extra after backfill = %#v, want cached album metadata", extra)
	}
}

func TestImportedCollectionSongsEndpointUsesLiveFetchAndBlocksMutations(t *testing.T) {
	initCollectionDBForTest(t)

	collection := Collection{
		UserID:      testUserID,
		Name:        "Imported Playlist",
		Kind:        collectionKindImported,
		ContentType: collectionContentPlaylist,
		Source:      "qq",
		ExternalID:  "playlist-1",
		TrackCount:  2,
	}
	if err := db.Create(&collection).Error; err != nil {
		t.Fatalf("create imported collection: %v", err)
	}

	origPlaylistDetail := playlistDetailFuncProvider
	playlistDetailFuncProvider = func(source string) func(string) ([]model.Song, error) {
		if source != "qq" {
			t.Fatalf("playlist detail source = %q, want qq", source)
		}
		return func(id string) ([]model.Song, error) {
			if id != "playlist-1" {
				t.Fatalf("playlist detail id = %q, want playlist-1", id)
			}
			return []model.Song{
				{ID: "song-1", Source: "qq", Name: "Song One", Artist: "Artist A"},
				{ID: "song-2", Source: "qq", Name: "Song Two", Artist: "Artist B"},
			}, nil
		}
	}
	t.Cleanup(func() {
		playlistDetailFuncProvider = origPlaylistDetail
	})

	router := newCollectionTestRouter()

	songsPath := fmt.Sprintf("%s/collections/%d/songs", RoutePrefix, collection.ID)

	req := httptest.NewRequest(http.MethodGet, songsPath, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s status = %d, want %d, body=%s", songsPath, rec.Code, http.StatusOK, rec.Body.String())
	}

	var songs []map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &songs); err != nil {
		t.Fatalf("decode live songs: %v", err)
	}
	if len(songs) != 2 {
		t.Fatalf("live songs len = %d, want 2", len(songs))
	}
	if songs[0]["id"] != "song-1" {
		t.Fatalf("first live song id = %#v, want song-1", songs[0]["id"])
	}

	addBody := bytes.NewBufferString(`{"id":"song-1","source":"qq","name":"Song One"}`)
	req = httptest.NewRequest(http.MethodPost, songsPath, addBody)
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("POST %s status = %d, want %d", songsPath, rec.Code, http.StatusBadRequest)
	}

	req = httptest.NewRequest(http.MethodDelete, songsPath+"?id=song-1&source=qq", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("DELETE %s status = %d, want %d", songsPath, rec.Code, http.StatusBadRequest)
	}
}

func TestManualCollectionSongsEndpointSupportsBatchDelete(t *testing.T) {
	initCollectionDBForTest(t)

	collection := Collection{
		UserID:      testUserID,
		Name:        "Manual Playlist",
		Kind:        collectionKindManual,
		ContentType: collectionContentPlaylist,
		Source:      "local",
	}
	if err := db.Create(&collection).Error; err != nil {
		t.Fatalf("create manual collection: %v", err)
	}

	saved := []SavedSong{
		{CollectionID: collection.ID, SongID: "song-1", Source: "qq", Name: "Song One"},
		{CollectionID: collection.ID, SongID: "song-2", Source: localMusicSource, Name: "Song Two"},
		{CollectionID: collection.ID, SongID: "song-3", Source: "netease", Name: "Song Three"},
	}
	if err := db.Create(&saved).Error; err != nil {
		t.Fatalf("create saved songs: %v", err)
	}

	router := newCollectionTestRouter()
	body := bytes.NewBufferString(`{"songs":[{"id":"song-1","source":"qq"},{"id":"song-2","source":"local"}]}`)
	req := httptest.NewRequest(http.MethodDelete, fmt.Sprintf("%s/collections/%d/songs", RoutePrefix, collection.ID), body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE batch songs status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var remaining []SavedSong
	if err := db.Where("collection_id = ?", collection.ID).Order("song_id ASC").Find(&remaining).Error; err != nil {
		t.Fatalf("query remaining songs: %v", err)
	}
	if len(remaining) != 1 {
		t.Fatalf("remaining songs len = %d, want 1", len(remaining))
	}
	if remaining[0].SongID != "song-3" {
		t.Fatalf("remaining song = %q, want song-3", remaining[0].SongID)
	}
}

func TestLoadImportedCollectionSongsFallsBackToParse(t *testing.T) {
	origPlaylistDetail := playlistDetailFuncProvider
	origParsePlaylist := parsePlaylistFuncProvider
	playlistDetailFuncProvider = func(string) func(string) ([]model.Song, error) {
		return nil
	}
	parsePlaylistFuncProvider = func(source string) func(string) (*model.Playlist, []model.Song, error) {
		if source != "qq" {
			t.Fatalf("parse playlist source = %q, want qq", source)
		}
		return func(link string) (*model.Playlist, []model.Song, error) {
			if link != "https://example.com/playlist/1" {
				t.Fatalf("parse playlist link = %q, want https://example.com/playlist/1", link)
			}
			return &model.Playlist{ID: "playlist-1"}, []model.Song{
				{ID: "song-parse", Name: "Parsed Song", Artist: "Parser"},
			}, nil
		}
	}
	t.Cleanup(func() {
		playlistDetailFuncProvider = origPlaylistDetail
		parsePlaylistFuncProvider = origParsePlaylist
	})

	songs, err := loadImportedCollectionSongs(&Collection{
		Kind:        collectionKindImported,
		ContentType: collectionContentPlaylist,
		Source:      "qq",
		ExternalID:  "playlist-1",
		Link:        "https://example.com/playlist/1",
	})
	if err != nil {
		t.Fatalf("loadImportedCollectionSongs() error = %v", err)
	}
	if len(songs) != 1 {
		t.Fatalf("parsed songs len = %d, want 1", len(songs))
	}
	if songs[0].ID != "song-parse" {
		t.Fatalf("parsed song id = %q, want song-parse", songs[0].ID)
	}
	if songs[0].Source != "qq" {
		t.Fatalf("parsed song source = %q, want qq", songs[0].Source)
	}
}

package web

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/guohuiyuan/go-music-dl/core"
	"github.com/guohuiyuan/music-lib/model"
)

func withLocalMusicDownloadDir(t *testing.T, dir string) {
	t.Helper()

	original := localMusicDownloadDirProvider
	localMusicDownloadDirProvider = func() string {
		return dir
	}
	t.Cleanup(func() {
		localMusicDownloadDirProvider = original
	})
}

func newLocalMusicTestRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	group := r.Group(RoutePrefix)
	group.Use(withTestUser())
	RegisterMusicRoutes(group)
	RegisterCollectionRoutes(group)
	RegisterLocalMusicRoutes(group)
	return r
}

func TestSearchBoxTemplateShowsLocalMusicEntryNextToCollections(t *testing.T) {
	content, err := templateFS.ReadFile("templates/partials/search_box.html")
	if err != nil {
		t.Fatalf("ReadFile(search_box.html): %v", err)
	}

	html := string(content)
	if !strings.Contains(html, `onclick="openCollectionManager()"`) {
		t.Fatal("search box missing custom collection entry")
	}
	if !strings.Contains(html, `onclick="openLocalMusicPage()"`) {
		t.Fatal("search box missing local music page entry")
	}
	if !strings.Contains(html, `onclick="goToPlaylistCategories()"`) {
		t.Fatal("search box missing playlist categories entry")
	}
	if strings.Index(html, `onclick="openLocalMusicPage()"`) < strings.Index(html, `onclick="openCollectionManager()"`) {
		t.Fatal("local music entry should be placed to the right of custom collection entry")
	}
	if strings.Index(html, `onclick="goToPlaylistCategories()"`) < strings.Index(html, `onclick="openLocalMusicPage()"`) {
		t.Fatal("playlist categories entry should be placed to the right of local music entry")
	}
	if !strings.Contains(html, "本地音乐") {
		t.Fatal("search box missing local music label")
	}
	if !strings.Contains(html, "歌单分类") {
		t.Fatal("search box missing playlist categories label")
	}

	playlistGrid, err := templateFS.ReadFile("templates/partials/playlist_grid.html")
	if err != nil {
		t.Fatalf("ReadFile(playlist_grid.html): %v", err)
	}
	if strings.Contains(string(playlistGrid), `onclick="openLocalMusicModal()"`) {
		t.Fatal("local music entry should not be inside custom collection page header")
	}
}

func TestLocalMusicListScansDownloadDirWithFallbacks(t *testing.T) {
	initCollectionDBForTest(t)

	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)

	audioPath := filepath.Join(downloadDir, "Plain Track.mp3")
	if err := os.WriteFile(audioPath, []byte("not a real mp3, but has a supported extension"), 0644); err != nil {
		t.Fatalf("write local audio: %v", err)
	}

	collection := Collection{
		UserID:      testUserID,
		Name:        "Local",
		Kind:        collectionKindManual,
		ContentType: collectionContentPlaylist,
		Source:      "local",
	}
	if err := db.Create(&collection).Error; err != nil {
		t.Fatalf("create collection: %v", err)
	}

	localID := encodeLocalMusicID("Plain Track.mp3")
	if err := db.Create(&SavedSong{
		CollectionID: collection.ID,
		SongID:       localID,
		Source:       localMusicSource,
		Name:         "Plain Track",
		Artist:       "未知歌手",
	}).Error; err != nil {
		t.Fatalf("create saved local song: %v", err)
	}

	router := newLocalMusicTestRouter()
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("%s/local_music?collection_id=%d", RoutePrefix, collection.ID), nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /local_music status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var resp struct {
		Exists bool              `json:"exists"`
		Tracks []localMusicTrack `json:"tracks"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode local music response: %v", err)
	}
	if !resp.Exists {
		t.Fatal("local music response exists = false, want true")
	}
	if len(resp.Tracks) != 1 {
		t.Fatalf("local music tracks len = %d, want 1", len(resp.Tracks))
	}

	track := resp.Tracks[0]
	if track.ID != localID {
		t.Fatalf("track.ID = %q, want %q", track.ID, localID)
	}
	if track.Name != "Plain Track" {
		t.Fatalf("track.Name = %q, want Plain Track", track.Name)
	}
	if track.Artist != "未知歌手" {
		t.Fatalf("track.Artist = %q, want 未知歌手", track.Artist)
	}
	if !track.AlreadyAdded {
		t.Fatal("track.AlreadyAdded = false, want true")
	}
	if track.Source != localMusicSource {
		t.Fatalf("track.Source = %q, want %q", track.Source, localMusicSource)
	}
}

func TestApplyLocalProbeResultFillsMetadata(t *testing.T) {
	track := &localMusicTrack{
		Name:     "file-name",
		Artist:   "unknown",
		Album:    "",
		Duration: 0,
		Missing:  []string{"title", "artist", "album"},
		Extra:    map[string]string{},
	}

	applyLocalProbeResult(track, &localProbeResult{
		Duration: 186,
		Bitrate:  320,
		Title:    "Probe Title",
		Artist:   "Probe Artist",
		Album:    "Probe Album",
	})

	if track.Duration != 186 {
		t.Fatalf("track.Duration = %d, want 186", track.Duration)
	}
	if track.Name != "Probe Title" {
		t.Fatalf("track.Name = %q, want Probe Title", track.Name)
	}
	if track.Artist != "Probe Artist" {
		t.Fatalf("track.Artist = %q, want Probe Artist", track.Artist)
	}
	if track.Album != "Probe Album" {
		t.Fatalf("track.Album = %q, want Probe Album", track.Album)
	}
	if len(track.Missing) != 0 {
		t.Fatalf("track.Missing = %v, want empty", track.Missing)
	}
	if track.Extra["duration"] != "186" || track.Extra["bitrate"] != "320" {
		t.Fatalf("track.Extra = %v, want duration and bitrate", track.Extra)
	}
}

func TestLocalMusicSidecarCoverAndLyricFallbacks(t *testing.T) {
	initCollectionDBForTest(t)

	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)

	audioPath := filepath.Join(downloadDir, "Sidecar Song.mp3")
	coverPath := filepath.Join(downloadDir, "Sidecar Song.png")
	lyricPath := filepath.Join(downloadDir, "Sidecar Song.lrc")
	coverBytes := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
	lyricText := "[00:01.00]Sidecar lyric line"
	if err := os.WriteFile(audioPath, []byte("not a real mp3"), 0644); err != nil {
		t.Fatalf("write local audio: %v", err)
	}
	if err := os.WriteFile(coverPath, coverBytes, 0644); err != nil {
		t.Fatalf("write sidecar cover: %v", err)
	}
	if err := os.WriteFile(lyricPath, []byte(lyricText), 0644); err != nil {
		t.Fatalf("write sidecar lyric: %v", err)
	}

	router := newLocalMusicTestRouter()
	req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/local_music", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /local_music status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var resp struct {
		Tracks []localMusicTrack `json:"tracks"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode local music response: %v", err)
	}
	if len(resp.Tracks) != 1 {
		t.Fatalf("local music tracks len = %d, want 1", len(resp.Tracks))
	}

	track := resp.Tracks[0]
	if track.Cover == "" {
		t.Fatal("track.Cover is empty, want local cover URL")
	}
	if track.Extra["cover_source"] != "sidecar" {
		t.Fatalf("cover_source = %q, want sidecar", track.Extra["cover_source"])
	}
	if track.Extra["lyric_source"] != "sidecar" {
		t.Fatalf("lyric_source = %q, want sidecar", track.Extra["lyric_source"])
	}

	req = httptest.NewRequest(http.MethodGet, RoutePrefix+"/local_music/cover?id="+url.QueryEscape(track.ID), nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET local cover status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("local cover content type = %q, want image/png", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), coverBytes) {
		t.Fatalf("local cover body = %v, want %v", rec.Body.Bytes(), coverBytes)
	}

	lyricURL := fmt.Sprintf("%s/download_lrc?id=%s&source=%s&name=Sidecar%%20Song&artist=Unknown", RoutePrefix, url.QueryEscape(track.ID), localMusicSource)
	req = httptest.NewRequest(http.MethodGet, lyricURL, nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET local download_lrc status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), lyricText) {
		t.Fatalf("local download_lrc body = %q, want lyric %q", rec.Body.String(), lyricText)
	}
	if !strings.Contains(rec.Header().Get("Content-Disposition"), ".lrc") {
		t.Fatalf("local download_lrc missing lrc download header: %q", rec.Header().Get("Content-Disposition"))
	}

	req = httptest.NewRequest(http.MethodGet, fmt.Sprintf("%s/lyric?id=%s&source=%s", RoutePrefix, url.QueryEscape(track.ID), localMusicSource), nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET local lyric status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), lyricText) {
		t.Fatalf("local lyric body = %q, want lyric %q", rec.Body.String(), lyricText)
	}
}

func TestLocalMusicListIncludesEmbeddedCover(t *testing.T) {
	initCollectionDBForTest(t)

	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)

	coverBytes := []byte{0xff, 0xd8, 0xff, 0xd9}
	embedded, err := core.EmbedSongMetadata(
		[]byte{0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00},
		&model.Song{Name: "Embedded Cover", Artist: "Local Artist", Album: "Local Album", Ext: "mp3"},
		"",
		coverBytes,
		"image/jpeg",
	)
	if err != nil {
		t.Fatalf("EmbedSongMetadata() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(downloadDir, "Embedded Cover.mp3"), embedded, 0644); err != nil {
		t.Fatalf("write embedded cover audio: %v", err)
	}

	router := newLocalMusicTestRouter()
	req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/local_music", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /local_music status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var resp struct {
		Tracks []localMusicTrack `json:"tracks"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode local music response: %v", err)
	}
	if len(resp.Tracks) != 1 {
		t.Fatalf("local music tracks len = %d, want 1", len(resp.Tracks))
	}

	track := resp.Tracks[0]
	if track.Cover == "" {
		t.Fatal("track.Cover is empty, want embedded cover URL")
	}
	if track.Extra["cover_source"] != "embedded" {
		t.Fatalf("cover_source = %q, want embedded", track.Extra["cover_source"])
	}
	if track.Name != "Embedded Cover" || track.Artist != "Local Artist" || track.Album != "Local Album" {
		t.Fatalf("track metadata = %q/%q/%q, want embedded metadata", track.Name, track.Artist, track.Album)
	}

	req = httptest.NewRequest(http.MethodGet, RoutePrefix+"/local_music/cover?id="+url.QueryEscape(track.ID), nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET local embedded cover status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "image/jpeg" {
		t.Fatalf("local embedded cover content type = %q, want image/jpeg", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), coverBytes) {
		t.Fatalf("local embedded cover body = %v, want %v", rec.Body.Bytes(), coverBytes)
	}
}

func TestUploadLocalMusicAddToCollectionAndDownload(t *testing.T) {
	initCollectionDBForTest(t)

	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)

	collection := Collection{
		UserID:      testUserID,
		Name:        "Uploads",
		Kind:        collectionKindManual,
		ContentType: collectionContentPlaylist,
		Source:      "local",
	}
	if err := db.Create(&collection).Error; err != nil {
		t.Fatalf("create collection: %v", err)
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "Uploaded Song.flac")
	if err != nil {
		t.Fatalf("create multipart file: %v", err)
	}
	if _, err := part.Write([]byte("fLaC uploaded audio bytes")); err != nil {
		t.Fatalf("write multipart file: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	router := newLocalMusicTestRouter()
	req := httptest.NewRequest(http.MethodPost, RoutePrefix+"/local_music/upload", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("POST /local_music/upload status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var uploadResp struct {
		Track localMusicTrack `json:"track"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &uploadResp); err != nil {
		t.Fatalf("decode upload response: %v", err)
	}
	if uploadResp.Track.ID == "" {
		t.Fatal("uploaded track ID is empty")
	}
	if uploadResp.Track.Name != "Uploaded Song" {
		t.Fatalf("uploaded track name = %q, want Uploaded Song", uploadResp.Track.Name)
	}

	addBody, err := json.Marshal(map[string]string{"id": uploadResp.Track.ID})
	if err != nil {
		t.Fatalf("marshal add body: %v", err)
	}
	addPath := fmt.Sprintf("%s/collections/%d/local_music", RoutePrefix, collection.ID)
	req = httptest.NewRequest(http.MethodPost, addPath, bytes.NewReader(addBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("POST %s status = %d, want %d, body=%s", addPath, rec.Code, http.StatusOK, rec.Body.String())
	}

	var saved SavedSong
	if err := db.Where("collection_id = ? AND song_id = ? AND source = ?", collection.ID, uploadResp.Track.ID, localMusicSource).First(&saved).Error; err != nil {
		t.Fatalf("query saved local song: %v", err)
	}
	if saved.Name != "Uploaded Song" || saved.Artist != "未知歌手" {
		t.Fatalf("saved local song metadata = %q/%q, want Uploaded Song/未知歌手", saved.Name, saved.Artist)
	}

	downloadURL := fmt.Sprintf("%s/download?id=%s&source=%s", RoutePrefix, uploadResp.Track.ID, localMusicSource)
	req = httptest.NewRequest(http.MethodGet, downloadURL, nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET local download status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if rec.Body.String() != "fLaC uploaded audio bytes" {
		t.Fatalf("download body = %q, want uploaded bytes", rec.Body.String())
	}
}

func TestDeleteLocalMusicRequiresRemovingCollectionReferencesFirst(t *testing.T) {
	initCollectionDBForTest(t)

	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)

	audioPath := filepath.Join(downloadDir, "Delete Me.mp3")
	if err := os.WriteFile(audioPath, []byte("delete me"), 0644); err != nil {
		t.Fatalf("write local audio: %v", err)
	}
	localID := encodeLocalMusicID("Delete Me.mp3")

	collections := []Collection{
		{UserID: testUserID, Name: "Local One", Kind: collectionKindManual, ContentType: collectionContentPlaylist, Source: "local"},
		{UserID: testUserID, Name: "Local Two", Kind: collectionKindManual, ContentType: collectionContentPlaylist, Source: "local"},
	}
	if err := db.Create(&collections).Error; err != nil {
		t.Fatalf("create collections: %v", err)
	}

	saved := []SavedSong{
		{CollectionID: collections[0].ID, SongID: localID, Source: localMusicSource, Name: "Delete Me"},
		{CollectionID: collections[1].ID, SongID: localID, Source: legacyLocalMusicSource, Name: "Delete Me"},
	}
	if err := db.Create(&saved).Error; err != nil {
		t.Fatalf("create saved local songs: %v", err)
	}

	router := newLocalMusicTestRouter()
	req := httptest.NewRequest(http.MethodDelete, RoutePrefix+"/local_music?id="+url.QueryEscape(localID), nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("DELETE /local_music status = %d, want %d, body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Local One") || !strings.Contains(rec.Body.String(), "Local Two") {
		t.Fatalf("DELETE /local_music body = %s, want referenced collection names", rec.Body.String())
	}
	if _, err := os.Stat(audioPath); err != nil {
		t.Fatalf("local file should still exist after blocked deletion: %v", err)
	}

	var count int64
	if err := db.Model(&SavedSong{}).
		Where("song_id = ? AND source IN ?", localID, []string{localMusicSource, legacyLocalMusicSource}).
		Count(&count).Error; err != nil {
		t.Fatalf("count saved local songs: %v", err)
	}
	if count != 2 {
		t.Fatalf("saved local songs count = %d, want 2", count)
	}

	for _, savedSong := range saved {
		removeURL := fmt.Sprintf("%s/collections/%d/songs?id=%s&source=%s", RoutePrefix, savedSong.CollectionID, url.QueryEscape(savedSong.SongID), url.QueryEscape(savedSong.Source))
		req = httptest.NewRequest(http.MethodDelete, removeURL, nil)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("DELETE collection song status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
		}
	}

	req = httptest.NewRequest(http.MethodDelete, RoutePrefix+"/local_music?id="+url.QueryEscape(localID), nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE /local_music after uncollect status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if _, err := os.Stat(audioPath); !os.IsNotExist(err) {
		t.Fatalf("deleted local file stat err = %v, want not exists", err)
	}
}

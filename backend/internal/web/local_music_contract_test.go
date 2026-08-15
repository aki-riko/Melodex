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

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/gin-gonic/gin"
)

func withLocalMusicDownloadDir(t *testing.T, dir string) {
	t.Helper()
	previous := localMusicDownloadDirProvider
	localMusicDownloadDirProvider = func() string { return dir }
	t.Cleanup(func() { localMusicDownloadDirProvider = previous })
}

func newLocalMusicTestRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	group := router.Group(RoutePrefix)
	group.Use(withTestUser())
	RegisterMusicRoutes(group)
	RegisterCollectionRoutes(group)
	RegisterLocalMusicRoutes(group)
	return router
}

func decodeLocalMusicList(t *testing.T, recorder *httptest.ResponseRecorder) (bool, []localMusicTrack) {
	t.Helper()
	if recorder.Code != http.StatusOK {
		t.Fatalf("local music list status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Exists bool              `json:"exists"`
		Tracks []localMusicTrack `json:"tracks"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode local music list: %v", err)
	}
	return response.Exists, response.Tracks
}

func TestLocalMusicScanAndProbeContract(t *testing.T) {
	initCollectionDBForTest(t)
	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)
	if err := os.WriteFile(filepath.Join(downloadDir, "Plain Track.mp3"), []byte("fixture with a supported extension"), 0o644); err != nil {
		t.Fatalf("write local audio fixture: %v", err)
	}
	collection := createManualCollectionForContract(t, "Local")
	localID := encodeLocalMusicID("Plain Track.mp3")
	if err := db.Create(&SavedSong{CollectionID: collection.ID, SongID: localID, Source: localMusicSource, Name: "Plain Track", Artist: "未知歌手"}).Error; err != nil {
		t.Fatalf("seed local collection track: %v", err)
	}
	recorder := performCollectionRequest(newLocalMusicTestRouter(), http.MethodGet, fmt.Sprintf("%s/local_music?collection_id=%d", RoutePrefix, collection.ID), nil)
	exists, tracks := decodeLocalMusicList(t, recorder)
	if !exists || len(tracks) != 1 {
		t.Fatalf("local scan exists/count = %v/%d", exists, len(tracks))
	}
	track := tracks[0]
	if track.ID != localID || track.Name != "Plain Track" || track.Artist != "未知歌手" || !track.AlreadyAdded || track.Source != localMusicSource {
		t.Fatalf("scanned local track = %#v", track)
	}

	probeTarget := &localMusicTrack{Name: "file-name", Artist: "unknown", Missing: []string{"title", "artist", "album"}, Extra: map[string]string{}}
	applyLocalProbeResult(probeTarget, &localProbeResult{Duration: 186, Bitrate: 320, Title: "Probe Title", Artist: "Probe Artist", Album: "Probe Album"})
	if probeTarget.Duration != 186 || probeTarget.Name != "Probe Title" || probeTarget.Artist != "Probe Artist" || probeTarget.Album != "Probe Album" || len(probeTarget.Missing) != 0 {
		t.Fatalf("probe-enriched track = %#v", probeTarget)
	}
	if probeTarget.Extra["duration"] != "186" || probeTarget.Extra["bitrate"] != "320" {
		t.Fatalf("probe-enriched extra = %#v", probeTarget.Extra)
	}
}

func TestLocalMusicSidecarAssetContract(t *testing.T) {
	initCollectionDBForTest(t)
	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)
	cover := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
	lyric := "[00:01.00]Sidecar lyric line"
	fixtures := map[string][]byte{
		"Sidecar Song.mp3": []byte("not a real mp3"),
		"Sidecar Song.png": cover,
		"Sidecar Song.lrc": []byte(lyric),
	}
	for name, data := range fixtures {
		if err := os.WriteFile(filepath.Join(downloadDir, name), data, 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	router := newLocalMusicTestRouter()
	_, tracks := decodeLocalMusicList(t, performCollectionRequest(router, http.MethodGet, RoutePrefix+"/local_music", nil))
	if len(tracks) != 1 || tracks[0].Cover == "" || tracks[0].Extra["cover_source"] != "sidecar" || tracks[0].Extra["lyric_source"] != "sidecar" {
		t.Fatalf("sidecar track = %#v", tracks)
	}
	track := tracks[0]
	coverRecorder := performCollectionRequest(router, http.MethodGet, RoutePrefix+"/local_music/cover?id="+url.QueryEscape(track.ID), nil)
	if coverRecorder.Code != http.StatusOK || coverRecorder.Header().Get("Content-Type") != "image/png" || !bytes.Equal(coverRecorder.Body.Bytes(), cover) {
		t.Fatalf("sidecar cover status/type/body = %d/%q/%v", coverRecorder.Code, coverRecorder.Header().Get("Content-Type"), coverRecorder.Body.Bytes())
	}
	lyricPath := fmt.Sprintf("%s/download_lrc?id=%s&source=%s&name=Sidecar%%20Song&artist=Unknown", RoutePrefix, url.QueryEscape(track.ID), localMusicSource)
	lyricRecorder := performCollectionRequest(router, http.MethodGet, lyricPath, nil)
	if lyricRecorder.Code != http.StatusOK || !strings.Contains(lyricRecorder.Body.String(), lyric) || !strings.Contains(lyricRecorder.Header().Get("Content-Disposition"), ".lrc") {
		t.Fatalf("sidecar LRC response = %d/%q/%q", lyricRecorder.Code, lyricRecorder.Header().Get("Content-Disposition"), lyricRecorder.Body.String())
	}
	inlineRecorder := performCollectionRequest(router, http.MethodGet, fmt.Sprintf("%s/lyric?id=%s&source=%s", RoutePrefix, url.QueryEscape(track.ID), localMusicSource), nil)
	if inlineRecorder.Code != http.StatusOK || !strings.Contains(inlineRecorder.Body.String(), lyric) {
		t.Fatalf("inline sidecar lyric = %d/%q", inlineRecorder.Code, inlineRecorder.Body.String())
	}
}

func TestLocalMusicEmbeddedCoverContract(t *testing.T) {
	initCollectionDBForTest(t)
	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)
	cover := []byte{0xff, 0xd8, 0xff, 0xd9}
	media, err := core.EmbedSongMetadata([]byte{0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0}, &model.Track{Name: "Embedded Cover", Artist: "Local Artist", Album: "Local Album", Ext: "mp3"}, "", cover, "image/jpeg")
	if err != nil {
		t.Fatalf("embed cover fixture: %v", err)
	}
	if err := os.WriteFile(filepath.Join(downloadDir, "Embedded Cover.mp3"), media, 0o644); err != nil {
		t.Fatalf("write embedded cover fixture: %v", err)
	}
	router := newLocalMusicTestRouter()
	_, tracks := decodeLocalMusicList(t, performCollectionRequest(router, http.MethodGet, RoutePrefix+"/local_music", nil))
	if len(tracks) != 1 || tracks[0].Cover == "" || tracks[0].Extra["cover_source"] != "embedded" || tracks[0].Name != "Embedded Cover" || tracks[0].Artist != "Local Artist" || tracks[0].Album != "Local Album" {
		t.Fatalf("embedded-cover track = %#v", tracks)
	}
	recorder := performCollectionRequest(router, http.MethodGet, RoutePrefix+"/local_music/cover?id="+url.QueryEscape(tracks[0].ID), nil)
	if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Type") != "image/jpeg" || !bytes.Equal(recorder.Body.Bytes(), cover) {
		t.Fatalf("embedded cover response = %d/%q/%v", recorder.Code, recorder.Header().Get("Content-Type"), recorder.Body.Bytes())
	}
}

func multipartAudioFixture(t *testing.T, filename string, data []byte) (*bytes.Buffer, string) {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("create multipart audio: %v", err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatalf("write multipart audio: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart audio: %v", err)
	}
	return body, writer.FormDataContentType()
}

func TestLocalMusicUploadCollectionAndDownloadContract(t *testing.T) {
	initCollectionDBForTest(t)
	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)
	collection := createManualCollectionForContract(t, "Uploads")
	router := newLocalMusicTestRouter()
	body, contentType := multipartAudioFixture(t, "Uploaded Song.flac", []byte("fLaC uploaded audio bytes"))
	request := httptest.NewRequest(http.MethodPost, RoutePrefix+"/local_music/upload", body)
	request.Header.Set("Content-Type", contentType)
	upload := httptest.NewRecorder()
	router.ServeHTTP(upload, request)
	if upload.Code != http.StatusOK {
		t.Fatalf("upload status = %d, body=%s", upload.Code, upload.Body.String())
	}
	var response struct {
		Track localMusicTrack `json:"track"`
	}
	if err := json.Unmarshal(upload.Body.Bytes(), &response); err != nil || response.Track.ID == "" || response.Track.Name != "Uploaded Song" {
		t.Fatalf("upload response = %#v, err=%v", response, err)
	}
	addPayload, err := json.Marshal(map[string]string{"id": response.Track.ID})
	if err != nil {
		t.Fatalf("encode collection add: %v", err)
	}
	addPath := fmt.Sprintf("%s/collections/%d/local_music", RoutePrefix, collection.ID)
	add := performCollectionRequest(router, http.MethodPost, addPath, addPayload)
	if add.Code != http.StatusOK {
		t.Fatalf("add uploaded track status = %d, body=%s", add.Code, add.Body.String())
	}
	var saved SavedSong
	if err := db.Where("collection_id = ? AND song_id = ? AND source = ?", collection.ID, response.Track.ID, localMusicSource).First(&saved).Error; err != nil || saved.Name != "Uploaded Song" || saved.Artist != "未知歌手" {
		t.Fatalf("saved uploaded track = %#v, err=%v", saved, err)
	}
	downloadPath := fmt.Sprintf("%s/download?id=%s&source=%s", RoutePrefix, response.Track.ID, localMusicSource)
	download := performCollectionRequest(router, http.MethodGet, downloadPath, nil)
	if download.Code != http.StatusOK || download.Body.String() != "fLaC uploaded audio bytes" {
		t.Fatalf("uploaded download = %d/%q", download.Code, download.Body.String())
	}
}

func TestLocalMusicUploadLimitContract(t *testing.T) {
	initCollectionDBForTest(t)
	previousLimit := localMusicMaxUploadRequestBytes
	localMusicMaxUploadRequestBytes = 128
	t.Cleanup(func() { localMusicMaxUploadRequestBytes = previousLimit })
	body, contentType := multipartAudioFixture(t, "too-large.mp3", bytes.Repeat([]byte("x"), 512))
	request := httptest.NewRequest(http.MethodPost, RoutePrefix+"/local_music/upload", body)
	request.Header.Set("Content-Type", contentType)
	recorder := httptest.NewRecorder()
	newLocalMusicTestRouter().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized upload status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestLocalMusicDeletionReferenceContract(t *testing.T) {
	initCollectionDBForTest(t)
	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)
	audioPath, localID := localDeletionFixture(t, downloadDir)
	references := seedLocalDeletionReferences(t, localID)
	router := newLocalMusicTestRouter()
	deletePath := localDeletionPath(localID)
	blocked := performCollectionRequest(router, http.MethodDelete, deletePath, nil)
	blockedBody := blocked.Body.String()
	if blocked.Code != http.StatusBadRequest || !strings.Contains(blockedBody, "Local One") || !strings.Contains(blockedBody, "Local Two") {
		t.Fatalf("blocked deletion = %d/%s", blocked.Code, blocked.Body.String())
	}
	if _, err := os.Stat(audioPath); err != nil {
		t.Fatalf("blocked deletion removed media: %v", err)
	}
	count, err := countLocalDeletionReferences(localID)
	if err != nil || count != int64(len(references)) {
		t.Fatalf("reference count = %d, err=%v", count, err)
	}
	removeLocalDeletionReferences(t, router, references)
	deleted := performCollectionRequest(router, http.MethodDelete, deletePath, nil)
	if deleted.Code != http.StatusOK {
		t.Fatalf("unreferenced deletion status = %d, body=%s", deleted.Code, deleted.Body.String())
	}
	if _, err := os.Stat(audioPath); !os.IsNotExist(err) {
		t.Fatalf("deleted media stat = %v", err)
	}
}

func localDeletionFixture(t *testing.T, downloadDir string) (string, string) {
	t.Helper()
	filename := "Delete Me.mp3"
	audioPath := filepath.Join(downloadDir, filename)
	if err := os.WriteFile(audioPath, []byte("delete me"), 0o644); err != nil {
		t.Fatalf("write deletion fixture: %v", err)
	}
	return audioPath, encodeLocalMusicID(filename)
}

func localDeletionPath(localID string) string {
	return RoutePrefix + "/local_music?id=" + url.QueryEscape(localID)
}

func seedLocalDeletionReferences(t *testing.T, localID string) []SavedSong {
	t.Helper()
	fixtures := []struct {
		collectionName string
		source         string
	}{
		{collectionName: "Local One", source: localMusicSource},
		{collectionName: "Local Two", source: legacyLocalMusicSource},
	}
	references := make([]SavedSong, 0, len(fixtures))
	for _, fixture := range fixtures {
		collection := createManualCollectionForContract(t, fixture.collectionName)
		reference := SavedSong{}
		reference.CollectionID = collection.ID
		reference.SongID = localID
		reference.Source = fixture.source
		reference.Name = "Delete Me"
		if err := db.Create(&reference).Error; err != nil {
			t.Fatalf("seed %s reference: %v", fixture.collectionName, err)
		}
		references = append(references, reference)
	}
	return references
}

func countLocalDeletionReferences(localID string) (int64, error) {
	var count int64
	sources := []string{localMusicSource, legacyLocalMusicSource}
	err := db.Model(&SavedSong{}).Where("song_id = ? AND source IN ?", localID, sources).Count(&count).Error
	return count, err
}

func removeLocalDeletionReferences(t *testing.T, router http.Handler, references []SavedSong) {
	t.Helper()
	for _, reference := range references {
		query := url.Values{}
		query.Set("id", reference.SongID)
		query.Set("source", reference.Source)
		endpoint := fmt.Sprintf("%s/collections/%d/songs?%s", RoutePrefix, reference.CollectionID, query.Encode())
		response := performCollectionRequest(router, http.MethodDelete, endpoint, nil)
		if response.Code != http.StatusOK {
			t.Fatalf("remove collection reference status = %d, body=%s", response.Code, response.Body.String())
		}
	}
}

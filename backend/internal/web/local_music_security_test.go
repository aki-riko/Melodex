package web

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func localMusicRouterForUser(userID uint, role string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	group := router.Group(RoutePrefix)
	group.Use(func(c *gin.Context) {
		c.Set(ctxUserID, userID)
		c.Set(ctxUserRole, role)
		c.Next()
	})
	RegisterMusicRoutes(group)
	RegisterCollectionRoutes(group)
	RegisterLocalMusicRoutes(group)
	return router
}

func TestLocalMusicAssetsAndCollectionEnforceOwnership(t *testing.T) {
	setupUserTestDB(t)
	alice, _ := createUser("local-owner", "alicepass1", RoleUser)
	bob, _ := createUser("local-reader", "bobpass123", RoleUser)

	dir := t.TempDir()
	withLocalMusicDownloadDir(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "private.mp3"), []byte("ID3 private audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "private.png"), []byte("private-cover"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "private.lrc"), []byte("[00:01.00]private lyric"), 0o644); err != nil {
		t.Fatal(err)
	}
	id := encodeLocalMusicID("private.mp3")
	if err := recordDownload(alice.ID, "private.mp3", localMusicSource, id, "Private", "Alice"); err != nil {
		t.Fatal(err)
	}
	bobCollection := Collection{
		UserID: bob.ID, Name: "Bob", Kind: collectionKindManual,
		ContentType: collectionContentPlaylist, Source: localMusicSource,
	}
	if err := db.Create(&bobCollection).Error; err != nil {
		t.Fatal(err)
	}

	bobRouter := localMusicRouterForUser(bob.ID, RoleUser)
	requests := []struct {
		method string
		path   string
		body   []byte
		want   int
	}{
		{http.MethodGet, RoutePrefix + "/local_music/cover?id=" + id, nil, http.StatusNotFound},
		{http.MethodGet, RoutePrefix + "/inspect?source=" + localMusicSource + "&id=" + id, nil, http.StatusOK},
		{http.MethodGet, RoutePrefix + "/download_lrc?source=" + localMusicSource + "&id=" + id, nil, http.StatusNotFound},
		{http.MethodPost, RoutePrefix + "/collections/" + uintToStr(bobCollection.ID) + "/local_music", []byte(`{"id":"` + id + `"}`), http.StatusNotFound},
	}
	for _, test := range requests {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(test.method, test.path, bytes.NewReader(test.body))
		if len(test.body) > 0 {
			request.Header.Set("Content-Type", "application/json")
		}
		bobRouter.ServeHTTP(recorder, request)
		if recorder.Code != test.want {
			t.Fatalf("%s %s status=%d, want %d, body=%s", test.method, test.path, recorder.Code, test.want, recorder.Body.String())
		}
		if strings.Contains(recorder.Body.String(), "private lyric") || strings.Contains(recorder.Body.String(), "private-cover") {
			t.Fatalf("%s leaked another user's local asset: %q", test.path, recorder.Body.String())
		}
		if strings.Contains(test.path, "/inspect") {
			var response struct {
				Valid bool `json:"valid"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil || response.Valid {
				t.Fatalf("cross-user inspect response=%s, err=%v", recorder.Body.String(), err)
			}
		}
	}

	aliceRouter := localMusicRouterForUser(alice.ID, RoleUser)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, RoutePrefix+"/local_music/cover?id="+id, nil)
	aliceRouter.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || recorder.Body.String() != "private-cover" {
		t.Fatalf("owner cover status=%d body=%q", recorder.Code, recorder.Body.String())
	}
}

func TestLocalMusicRejectsSymlinkOutsideDownloadDirectory(t *testing.T) {
	root := t.TempDir()
	outsideDir := t.TempDir()
	outside := filepath.Join(outsideDir, "outside.mp3")
	if err := os.WriteFile(outside, []byte("outside audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "linked.mp3")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("current Windows policy cannot create symlinks: %v", err)
	}
	withLocalMusicDownloadDir(t, root)
	if _, err := localMusicTrackByID(encodeLocalMusicID("linked.mp3")); err == nil {
		t.Fatal("localMusicTrackByID accepted a symlink outside the download directory")
	}
}

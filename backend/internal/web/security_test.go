package web

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

// download_cover 对内网/环回 URL 应返回 403(SSRF 防护)。
func TestDownloadCoverRejectsSSRF(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterMusicRoutes(r.Group(RoutePrefix))

	for _, u := range []string{
		"http://127.0.0.1/x.jpg",
		"http://169.254.169.254/latest/meta-data/",
		"http://localhost:8329/",
		"http://10.0.0.1/a",
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/download_cover?url="+u, nil)
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("download_cover url=%s status=%d, want 403", u, rec.Code)
		}
	}
}

// 本地音频流:非归属用户 / 匿名访问应 404(归属隔离)。
func TestLocalAudioStreamOwnership(t *testing.T) {
	setupUserTestDB(t)
	alice, _ := createUser("alice", "alicepass1", RoleUser)
	bob, _ := createUser("bob", "bobpass1", RoleUser)

	dir := t.TempDir()
	withLocalMusicDownloadDir(t, dir)
	rel := "alice-song.mp3"
	if err := os.WriteFile(filepath.Join(dir, rel), []byte("ID3audio-bytes-padding-xxxxxxxxxx"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	recordDownload(alice.ID, rel, localMusicSource, "x", "S", "A")
	invalidateLocalMusicScanCache()

	// 解析出该 track 的 id(base64 relPath)
	tracks, _, _, _, _, _ := scanLocalMusicTracksCached(true)
	if len(tracks) == 0 {
		t.Fatal("track not scanned")
	}
	id := tracks[0].ID

	routerFor := func(uid uint, admin bool) *gin.Engine {
		gin.SetMode(gin.TestMode)
		r := gin.New()
		grp := r.Group(RoutePrefix)
		grp.Use(func(c *gin.Context) {
			c.Set(ctxUserID, uid)
			c.Set(ctxUserRole, map[bool]string{true: RoleAdmin, false: RoleUser}[admin])
			c.Next()
		})
		RegisterMusicRoutes(grp)
		return r
	}

	// bob(非归属)→ 404
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/download?source="+localMusicSource+"&id="+id, nil)
	routerFor(bob.ID, false).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("bob stream status=%d, want 404", rec.Code)
	}

	// alice(归属)→ 非 404
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, RoutePrefix+"/download?source="+localMusicSource+"&id="+id, nil)
	routerFor(alice.ID, false).ServeHTTP(rec, req)
	if rec.Code == http.StatusNotFound {
		t.Fatalf("alice (owner) should access her file, got 404")
	}
}

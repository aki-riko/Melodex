package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

// routerForUser 构建一个把当前用户固定为 uid/role 的 collection+local_music router。
func routerForUser(uid uint, role string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	grp := r.Group(RoutePrefix)
	grp.Use(func(c *gin.Context) {
		c.Set(ctxUserID, uid)
		c.Set(ctxUserRole, role)
		c.Set(ctxUsername, "u")
		c.Next()
	})
	RegisterCollectionRoutes(grp)
	RegisterLocalMusicRoutes(grp)
	return r
}

func createCollectionViaAPI(t *testing.T, r *gin.Engine, name string) uint {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, RoutePrefix+"/collections", jsonBody(map[string]string{"name": name}))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create collection %q status=%d body=%s", name, rec.Code, rec.Body.String())
	}
	var resp struct {
		ID uint `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode create resp: %v", err)
	}
	return resp.ID
}

func listCollectionIDs(t *testing.T, r *gin.Engine) []uint {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/collections", nil)
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list collections status=%d", rec.Code)
	}
	var cols []Collection
	if err := json.Unmarshal(rec.Body.Bytes(), &cols); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	ids := make([]uint, 0, len(cols))
	for _, c := range cols {
		ids = append(ids, c.ID)
	}
	return ids
}

// TestNonAdminUploadVisibleToSelf 回归:普通用户上传后必须在自己本地库可见
// (上传须登记 DownloadRecord,否则被 filterLocalTracksForUser 隐藏)。
func TestNonAdminUploadVisibleToSelf(t *testing.T) {
	setupUserTestDB(t)
	alice, _ := createUser("alice", "alicepass1", RoleUser)

	dir := t.TempDir()
	withLocalMusicDownloadDir(t, dir)

	// 直接造文件 + 登记归属(等价于 upload handler 内 recordDownload 的效果)。
	rel := "alice-upload.mp3"
	if err := os.WriteFile(filepath.Join(dir, rel), []byte("ID3test-audio-bytes-padding-padding"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	if err := recordDownload(alice.ID, rel, localMusicSource, "x", "AliceUpload", "A"); err != nil {
		t.Fatalf("recordDownload: %v", err)
	}
	invalidateLocalMusicScanCache()

	tracks, _, _, _, _, _ := scanLocalMusicTracksCached(true)
	// 普通用户视图:能看到自己登记的文件。
	mine := filterLocalTracksForUser(tracks, alice.ID, false)
	if len(mine) != 1 {
		t.Fatalf("alice should see her uploaded file, got %d", len(mine))
	}
	// 另一个无归属的普通用户看不到。
	bob, _ := createUser("bob", "bobpass1", RoleUser)
	if got := filterLocalTracksForUser(tracks, bob.ID, false); len(got) != 0 {
		t.Fatalf("bob should not see alice's upload, got %d", len(got))
	}
}

func TestCollectionsIsolatedAcrossUsers(t *testing.T) {
	setupUserTestDB(t)
	alice, _ := createUser("alice", "alicepass1", RoleUser)
	bob, _ := createUser("bob", "bobpass1", RoleUser)

	aliceR := routerForUser(alice.ID, RoleUser)
	bobR := routerForUser(bob.ID, RoleUser)

	aliceCol := createCollectionViaAPI(t, aliceR, "Alice歌单")
	bobCol := createCollectionViaAPI(t, bobR, "Bob歌单")

	// alice 只看到自己的。
	aliceIDs := listCollectionIDs(t, aliceR)
	if len(aliceIDs) != 1 || aliceIDs[0] != aliceCol {
		t.Fatalf("alice should see only her collection, got %v", aliceIDs)
	}
	bobIDs := listCollectionIDs(t, bobR)
	if len(bobIDs) != 1 || bobIDs[0] != bobCol {
		t.Fatalf("bob should see only his collection, got %v", bobIDs)
	}

	// bob 不能访问 alice 的歌单详情(按不存在处理)。
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/collections/"+uintToStr(aliceCol)+"/songs", nil)
	bobR.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("bob accessing alice's collection songs status=%d, want 404", rec.Code)
	}

	// bob 不能删除 alice 的歌单。
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodDelete, RoutePrefix+"/collections/"+uintToStr(aliceCol), nil)
	bobR.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("bob deleting alice's collection status=%d, want 404", rec.Code)
	}

	// 确认 alice 的歌单仍在。
	if ids := listCollectionIDs(t, aliceR); len(ids) != 1 {
		t.Fatalf("alice's collection should survive bob's delete attempt, got %v", ids)
	}

	// bob 不能往 alice 的歌单加歌。
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, RoutePrefix+"/collections/"+uintToStr(aliceCol)+"/songs",
		jsonBody(map[string]interface{}{"id": "x", "source": "qq", "name": "n"}))
	req.Header.Set("Content-Type", "application/json")
	bobR.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("bob adding song to alice's collection status=%d, want 404", rec.Code)
	}
}

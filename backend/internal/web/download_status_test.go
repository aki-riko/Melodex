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

func TestDownloadsListRestoresRealPersistedRecordAndFiltersOwnership(t *testing.T) {
	setupUserTestDB(t)

	alice, err := createUser("alice-downloads", "alicepass1", RoleUser)
	if err != nil {
		t.Fatalf("create alice: %v", err)
	}
	bob, err := createUser("bob-downloads", "bobpass12", RoleUser)
	if err != nil {
		t.Fatalf("create bob: %v", err)
	}
	admin, err := createUser("admin-downloads", "adminpass1", RoleAdmin)
	if err != nil {
		t.Fatalf("create admin: %v", err)
	}

	rootDir := t.TempDir()
	downloadDir := filepath.Join(rootDir, "downloads")
	if err := os.MkdirAll(downloadDir, 0755); err != nil {
		t.Fatalf("create download dir: %v", err)
	}
	withLocalMusicDownloadDir(t, downloadDir)
	// 使用生产中只读核验过的真实身份字段与 rel_path 做回归输入；临时文件仅用于
	// 隔离测试中的存在性检查。旧实现完全不读取 DownloadRecord,刷新时状态必丢。
	aliceRel := "庭園にて。 - acane_madder.flac"
	if err := os.WriteFile(filepath.Join(downloadDir, aliceRel), []byte("real-record-fixture"), 0644); err != nil {
		t.Fatalf("write alice track: %v", err)
	}
	if err := recordDownload(alice.ID, aliceRel, "qq", "002l8AAo4GpCaf", "庭園にて。", "acane_madder"); err != nil {
		t.Fatalf("record alice download: %v", err)
	}

	// 第二条也取自生产真实记录,用于验证普通用户隔离与管理员全局可见。
	bobRel := "GATE OF STEINER - 佐佐木惠梨.flac"
	if err := os.WriteFile(filepath.Join(downloadDir, bobRel), []byte("real-record-fixture"), 0644); err != nil {
		t.Fatalf("write bob track: %v", err)
	}
	if err := recordDownload(bob.ID, bobRel, "qq", "003eSBVe0DWGpK", "GATE OF STEINER", "佐佐木惠梨"); err != nil {
		t.Fatalf("record bob download: %v", err)
	}

	// 有记录但文件已被人工移走的孤儿项不得恢复成“已下载”。
	if err := recordDownload(alice.ID, "missing.flac", "qq", "missing-song", "已移走", "未知"); err != nil {
		t.Fatalf("record stale download: %v", err)
	}
	outsideRel := "../outside.mp3"
	if err := os.WriteFile(filepath.Join(rootDir, "outside.mp3"), []byte("outside"), 0644); err != nil {
		t.Fatalf("write outside track: %v", err)
	}
	if err := recordDownload(alice.ID, outsideRel, "qq", "outside-song", "越界文件", "未知"); err != nil {
		t.Fatalf("record outside download: %v", err)
	}

	assertDownloads := func(t *testing.T, router http.Handler, wantIDs ...string) {
		t.Helper()
		rec := httptest.NewRecorder()
		// 即使伪造 user_id 查询参数,后端也必须只信任鉴权上下文。
		req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/downloads?user_id=999999", nil)
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET /downloads status=%d body=%s", rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
			t.Fatalf("Cache-Control=%q, want private, no-store", got)
		}

		var payload struct {
			Downloads []downloadStatusItem `json:"downloads"`
			Total     int                  `json:"total"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode downloads: %v", err)
		}
		if payload.Total != len(wantIDs) || len(payload.Downloads) != len(wantIDs) {
			t.Fatalf("downloads=%+v total=%d, want ids=%v", payload.Downloads, payload.Total, wantIDs)
		}
		got := make(map[string]downloadStatusItem, len(payload.Downloads))
		for _, item := range payload.Downloads {
			got[item.SongID] = item
		}
		for _, id := range wantIDs {
			if _, ok := got[id]; !ok {
				t.Fatalf("download id %q missing from %+v", id, payload.Downloads)
			}
		}
		if _, ok := got["missing-song"]; ok {
			t.Fatalf("stale missing file must not be returned: %+v", payload.Downloads)
		}
		if _, ok := got["outside-song"]; ok {
			t.Fatalf("path outside download dir must not be returned: %+v", payload.Downloads)
		}
	}

	assertDownloads(t, routerForUser(alice.ID, RoleUser), "002l8AAo4GpCaf")
	assertDownloads(t, routerForUser(admin.ID, RoleAdmin), "002l8AAo4GpCaf", "003eSBVe0DWGpK")
}

func TestDownloadsRouteRequiresLogin(t *testing.T) {
	setupUserTestDB(t)
	if _, err := createUser("downloads-root", "rootpass12", RoleAdmin); err != nil {
		t.Fatalf("create admin: %v", err)
	}

	gin.SetMode(gin.TestMode)
	engine := gin.New()
	group := engine.Group(RoutePrefix)
	group.Use(authRequired())
	RegisterLocalMusicRoutes(group)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/downloads", nil)
	req.Header.Set("Accept", "application/json")
	engine.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous GET /downloads status=%d body=%s, want 401", rec.Code, rec.Body.String())
	}
}

func TestMoveDownloadRecordsToPathPreservesAllOwners(t *testing.T) {
	setupUserTestDB(t)

	alice, err := createUser("alice-upgrade", "alicepass1", RoleUser)
	if err != nil {
		t.Fatalf("create alice: %v", err)
	}
	bob, err := createUser("bob-upgrade", "bobpass12", RoleUser)
	if err != nil {
		t.Fatalf("create bob: %v", err)
	}

	oldRel := "江南 - 林俊杰.mp3"
	newRel := "江南 - 林俊杰.flac"
	if err := recordDownload(alice.ID, oldRel, "migu", "old-alice-id", "江南", "林俊杰"); err != nil {
		t.Fatalf("record alice old path: %v", err)
	}
	if err := recordDownload(bob.ID, oldRel, "qq", "old-bob-id", "江南", "林俊杰"); err != nil {
		t.Fatalf("record bob old path: %v", err)
	}

	if err := moveDownloadRecordsToPath(oldRel, newRel); err != nil {
		t.Fatalf("move download records: %v", err)
	}
	// 当前下载者从另一来源完成升级时,同路径冲突应刷新其来源元数据。
	if err := recordDownload(alice.ID, newRel, "qq", "new-alice-id", "江南", "林俊杰"); err != nil {
		t.Fatalf("refresh alice metadata: %v", err)
	}

	var records []DownloadRecord
	if err := db.Order("user_id ASC").Find(&records).Error; err != nil {
		t.Fatalf("query records: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("records=%+v, want two owners preserved", records)
	}

	byUser := make(map[uint]DownloadRecord, len(records))
	for _, record := range records {
		byUser[record.UserID] = record
		if record.RelPath != newRel {
			t.Fatalf("record=%+v, want new rel path %q", record, newRel)
		}
	}
	if got := byUser[alice.ID]; got.Source != "qq" || got.SongID != "new-alice-id" {
		t.Fatalf("alice record=%+v, want refreshed source/id", got)
	}
	if got := byUser[bob.ID]; got.Source != "qq" || got.SongID != "old-bob-id" {
		t.Fatalf("bob record=%+v, want ownership metadata preserved", got)
	}
}

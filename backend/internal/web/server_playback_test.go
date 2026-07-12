package web

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

func musicRouterForUser(uid uint, role string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	group := router.Group(RoutePrefix)
	group.Use(func(c *gin.Context) {
		c.Set(ctxUserID, uid)
		c.Set(ctxUserRole, role)
		c.Set(ctxUsername, "playback-test")
		c.Next()
	})
	RegisterMusicRoutes(group)
	return router
}

func serverStreamURL(songID, source, name, artist string) string {
	params := url.Values{}
	params.Set("id", songID)
	params.Set("source", source)
	params.Set("name", name)
	params.Set("artist", artist)
	params.Set("stream", "1")
	return RoutePrefix + "/download?" + params.Encode()
}

func TestStreamPlaybackPrefersOwnedServerDownload(t *testing.T) {
	setupUserTestDB(t)

	alice, err := createUser("alice-playback", "alicepass1", RoleUser)
	if err != nil {
		t.Fatalf("create alice: %v", err)
	}

	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)

	// 真实生产失败输入:2026-07-13 线上 QQ 流 404,但同一 DownloadRecord 与 FLAC 均存在。
	qqRel := "凝眸 (对唱版) - 王心凌、张远.flac"
	qqAudio := []byte("fLaC-real-server-copy-凝眸-王心凌、张远")
	if err := os.WriteFile(filepath.Join(downloadDir, qqRel), qqAudio, 0644); err != nil {
		t.Fatalf("write qq fixture: %v", err)
	}
	if err := recordDownload(alice.ID, qqRel, "qq", "001MPeqh1mdABU", "凝眸 (对唱版)", "王心凌、张远"); err != nil {
		t.Fatalf("record qq download: %v", err)
	}

	router := musicRouterForUser(alice.ID, RoleUser)
	streamURL := serverStreamURL("001MPeqh1mdABU", "qq", "凝眸 (对唱版)", "王心凌、张远")
	req := httptest.NewRequest(http.MethodGet, streamURL, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("server stream status=%d body=%q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-Melodex-Playback-Source"); got != "server" {
		t.Fatalf("playback source header=%q, want server", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), qqAudio) {
		t.Fatalf("server stream body=%q, want local bytes %q", rec.Body.Bytes(), qqAudio)
	}

	// 本地 ServeContent 必须继续支持浏览器拖动进度所需的 Range。
	req = httptest.NewRequest(http.MethodGet, streamURL, nil)
	req.Header.Set("Range", "bytes=5-15")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("range stream status=%d body=%q, want 206", rec.Code, rec.Body.String())
	}
	if !bytes.Equal(rec.Body.Bytes(), qqAudio[5:16]) {
		t.Fatalf("range body=%q, want %q", rec.Body.Bytes(), qqAudio[5:16])
	}
}

func TestStreamPlaybackFallsBackToSameTitleArtistAcrossSources(t *testing.T) {
	setupUserTestDB(t)

	alice, err := createUser("alice-cross-source", "alicepass1", RoleUser)
	if err != nil {
		t.Fatalf("create alice: %v", err)
	}

	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)

	// 第二个真实生产样本:QQ 身份仍显示在歌单中,物理文件记录已被咪咕 upsert。
	rel := "炽心 - 希林娜依高.flac"
	audio := []byte("fLaC-real-server-copy-炽心-希林娜依高")
	if err := os.WriteFile(filepath.Join(downloadDir, rel), audio, 0644); err != nil {
		t.Fatalf("write migu fixture: %v", err)
	}
	if err := recordDownload(alice.ID, rel, "migu", "600929000007375928|2|HQ", "炽心", "希林娜依高"); err != nil {
		t.Fatalf("record migu download: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, serverStreamURL("002XiILV3rtslm", "qq", "炽心", "希林娜依高"), nil)
	rec := httptest.NewRecorder()
	musicRouterForUser(alice.ID, RoleUser).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || rec.Header().Get("X-Melodex-Playback-Source") != "server" {
		t.Fatalf("cross-source stream status=%d source=%q body=%q", rec.Code, rec.Header().Get("X-Melodex-Playback-Source"), rec.Body.String())
	}
	if !bytes.Equal(rec.Body.Bytes(), audio) {
		t.Fatalf("cross-source body=%q, want local bytes %q", rec.Body.Bytes(), audio)
	}
}

func TestServerPlaybackResolverHonorsOwnershipAndRejectsInvalidRecords(t *testing.T) {
	setupUserTestDB(t)

	alice, err := createUser("alice-resolver", "alicepass1", RoleUser)
	if err != nil {
		t.Fatalf("create alice: %v", err)
	}
	bob, err := createUser("bob-resolver", "bobpass12", RoleUser)
	if err != nil {
		t.Fatalf("create bob: %v", err)
	}
	admin, err := createUser("admin-resolver", "adminpass1", RoleAdmin)
	if err != nil {
		t.Fatalf("create admin: %v", err)
	}

	rootDir := t.TempDir()
	downloadDir := filepath.Join(rootDir, "downloads")
	if err := os.MkdirAll(downloadDir, 0755); err != nil {
		t.Fatalf("create download dir: %v", err)
	}
	withLocalMusicDownloadDir(t, downloadDir)

	bobRel := "GATE OF STEINER - 佐佐木惠梨.flac"
	if err := os.WriteFile(filepath.Join(downloadDir, bobRel), []byte("fLaC-bob-server-copy"), 0644); err != nil {
		t.Fatalf("write bob fixture: %v", err)
	}
	if err := recordDownload(bob.ID, bobRel, "qq", "003eSBVe0DWGpK", "GATE OF STEINER", "佐佐木惠梨"); err != nil {
		t.Fatalf("record bob download: %v", err)
	}
	if err := recordDownload(alice.ID, "missing.flac", "qq", "missing-song", "已移走", "未知"); err != nil {
		t.Fatalf("record orphan: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "outside.flac"), []byte("outside"), 0644); err != nil {
		t.Fatalf("write outside fixture: %v", err)
	}
	if err := recordDownload(alice.ID, "../outside.flac", "qq", "outside-song", "越界文件", "未知"); err != nil {
		t.Fatalf("record outside path: %v", err)
	}
	outsideDir := filepath.Join(rootDir, "outside-dir")
	if err := os.MkdirAll(outsideDir, 0755); err != nil {
		t.Fatalf("create outside dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(outsideDir, "escape.flac"), []byte("outside-through-symlink"), 0644); err != nil {
		t.Fatalf("write symlink target: %v", err)
	}
	symlinkRel := "linked/escape.flac"
	symlinkReady := true
	if err := os.Symlink(outsideDir, filepath.Join(downloadDir, "linked")); err != nil {
		// Windows 未开启开发者模式时无法创建符号链接;Linux/CI 会执行完整逃逸回归。
		symlinkReady = false
	} else if err := recordDownload(alice.ID, symlinkRel, "qq", "symlink-song", "符号链接越界", "未知"); err != nil {
		t.Fatalf("record symlink path: %v", err)
	}

	resolve := func(uid uint, role, source, songID, name, artist string) string {
		t.Helper()
		rel, resolveErr := existingDownloadRelPathForPlayback(uid, role == RoleAdmin, downloadDir, source, songID, name, artist)
		if resolveErr != nil {
			t.Fatalf("resolve %s/%s: %v", source, songID, resolveErr)
		}
		return rel
	}

	if got := resolve(alice.ID, RoleUser, "qq", "003eSBVe0DWGpK", "GATE OF STEINER", "佐佐木惠梨"); got != "" {
		t.Fatalf("alice resolved bob file %q", got)
	}
	if got := resolve(admin.ID, RoleAdmin, "qq", "003eSBVe0DWGpK", "GATE OF STEINER", "佐佐木惠梨"); got != bobRel {
		t.Fatalf("admin resolved %q, want %q", got, bobRel)
	}
	if got := resolve(alice.ID, RoleUser, "qq", "missing-song", "已移走", "未知"); got != "" {
		t.Fatalf("orphan record resolved %q", got)
	}
	if got := resolve(alice.ID, RoleUser, "qq", "outside-song", "越界文件", "未知"); got != "" {
		t.Fatalf("outside record resolved %q", got)
	}
	if symlinkReady {
		if got := resolve(alice.ID, RoleUser, "qq", "symlink-song", "符号链接越界", "未知"); got != "" {
			t.Fatalf("symlink escape resolved %q", got)
		}
	}
	if got := resolve(0, RoleUser, "qq", "003eSBVe0DWGpK", "GATE OF STEINER", "佐佐木惠梨"); got != "" {
		t.Fatalf("anonymous resolver returned %q", got)
	}
}

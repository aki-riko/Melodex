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

func TestServerPlaybackDoesNotFallbackAcrossSourcesWithoutExactIdentity(t *testing.T) {
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

	got, err := existingDownloadRelPathForPlayback(
		alice.ID,
		false,
		downloadDir,
		"qq",
		"002XiILV3rtslm",
		"炽心",
		"希林娜依高",
	)
	if err != nil {
		t.Fatalf("resolve QQ identity: %v", err)
	}
	if got != "" {
		t.Fatalf("QQ identity incorrectly reused cross-source path %q", got)
	}
}

func TestServerPlaybackDoesNotFallbackAcrossDifferentIDsFromSameSource(t *testing.T) {
	setupUserTestDB(t)

	alice, err := createUser("alice-versioned-playback", "alicepass1", RoleUser)
	if err != nil {
		t.Fatalf("create alice: %v", err)
	}

	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)

	// 真实生产失败输入:QQ 专辑解析曾把以下两个版本都压成“凝眸 / 王心凌, 张远”。
	// 原唱请求 001MPeqh1mdABU 因同名回退，错误播放了后下载的和声伴奏 0003q6YO4Xvxj6。
	rel := "凝眸 - 王心凌, 张远.flac"
	if err := os.WriteFile(filepath.Join(downloadDir, rel), []byte("harmony-instrumental"), 0644); err != nil {
		t.Fatalf("write accompaniment fixture: %v", err)
	}
	if err := recordDownload(alice.ID, rel, "qq", "0003q6YO4Xvxj6", "凝眸", "王心凌, 张远"); err != nil {
		t.Fatalf("record accompaniment: %v", err)
	}

	got, err := existingDownloadRelPathForPlayback(
		alice.ID,
		false,
		downloadDir,
		"qq",
		"001MPeqh1mdABU",
		"凝眸",
		"王心凌, 张远",
	)
	if err != nil {
		t.Fatalf("resolve original: %v", err)
	}
	if got != "" {
		t.Fatalf("original resolved accompaniment path %q", got)
	}
}

func TestConflictingDownloadIdentityUsesDistinctFilenameTemplate(t *testing.T) {
	setupUserTestDB(t)

	alice, err := createUser("alice-variant-download", "alicepass1", RoleUser)
	if err != nil {
		t.Fatalf("create alice: %v", err)
	}
	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)

	originalRel := "凝眸 - 王心凌, 张远.flac"
	if err := os.WriteFile(filepath.Join(downloadDir, originalRel), []byte("original-duet"), 0644); err != nil {
		t.Fatalf("write original fixture: %v", err)
	}
	if err := recordDownload(alice.ID, originalRel, "qq", "001MPeqh1mdABU", "凝眸", "王心凌, 张远"); err != nil {
		t.Fatalf("record original: %v", err)
	}

	conflict, err := hasConflictingDownloadIdentity(downloadDir, "qq", "000UWY2q4fCksJ", "凝眸", "王心凌, 张远")
	if err != nil {
		t.Fatalf("check accompaniment conflict: %v", err)
	}
	if !conflict {
		t.Fatal("same-title accompaniment should conflict with original identity")
	}
	crossSourceConflict, err := hasConflictingDownloadIdentity(downloadDir, "kuwo", "431545677", "凝眸", "王心凌, 张远")
	if err != nil {
		t.Fatalf("check cross-source conflict: %v", err)
	}
	if !crossSourceConflict {
		t.Fatal("same-title different-source identity should also use a distinct file")
	}
	if got := filenameTemplateWithSongIdentity("{name} - {artist}"); got != "{name} - {artist} [{source}-{id}]" {
		t.Fatalf("identity filename template = %q", got)
	}

	conflict, err = hasConflictingDownloadIdentity(downloadDir, "qq", "001MPeqh1mdABU", "凝眸", "王心凌, 张远")
	if err != nil {
		t.Fatalf("check exact identity: %v", err)
	}
	if conflict {
		t.Fatal("same source/song_id must remain an upgrade, not a variant conflict")
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

package web

import (
	"path/filepath"
	"testing"

	"github.com/guohuiyuan/go-music-dl/core"
	"golang.org/x/crypto/bcrypt"
)

// setupUserTestDB 用临时 settings.db 初始化一个干净的库(含用户/归属迁移)。
func setupUserTestDB(t *testing.T) {
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
}

func TestCreateUserAndUniqueness(t *testing.T) {
	setupUserTestDB(t)

	u, err := createUser("Alice", "secret123", RoleUser)
	if err != nil {
		t.Fatalf("createUser: %v", err)
	}
	if u.ID == 0 || u.Role != RoleUser || u.Username != "Alice" {
		t.Fatalf("unexpected user: %+v", u)
	}

	// 大小写不敏感的唯一性。
	if _, err := createUser("alice", "another123", RoleUser); err != ErrUsernameTaken {
		t.Fatalf("expected ErrUsernameTaken for case-insensitive dup, got %v", err)
	}

	// 短密码拒绝。
	if _, err := createUser("bob", "123", RoleUser); err != ErrInvalidPassword {
		t.Fatalf("expected ErrInvalidPassword, got %v", err)
	}

	// 非法用户名。
	if _, err := createUser("a", "secret123", RoleUser); err != ErrInvalidUsername {
		t.Fatalf("expected ErrInvalidUsername, got %v", err)
	}
}

func TestVerifyPasswordAndSetPassword(t *testing.T) {
	setupUserTestDB(t)
	u, err := createUser("carol", "origpass1", RoleUser)
	if err != nil {
		t.Fatalf("createUser: %v", err)
	}
	if !verifyPassword(u.PasswordHash, "origpass1") {
		t.Fatal("password should verify")
	}
	if verifyPassword(u.PasswordHash, "wrongpass") {
		t.Fatal("wrong password should not verify")
	}

	if err := setUserPassword(u.ID, "newpass99"); err != nil {
		t.Fatalf("setUserPassword: %v", err)
	}
	reloaded, err := findUserByID(u.ID)
	if err != nil {
		t.Fatalf("findUserByID: %v", err)
	}
	if !verifyPassword(reloaded.PasswordHash, "newpass99") {
		t.Fatal("new password should verify")
	}
}

func TestLastAdminProtection(t *testing.T) {
	setupUserTestDB(t)
	root, err := createUser("root", "rootpass1", RoleAdmin)
	if err != nil {
		t.Fatalf("createUser root: %v", err)
	}

	// 唯一管理员不能被降级。
	if err := setUserRole(root.ID, RoleUser); err != ErrLastRootProtected {
		t.Fatalf("expected ErrLastRootProtected on demote, got %v", err)
	}
	// 不能被禁用。
	if err := setUserDisabled(root.ID, true); err != ErrLastRootProtected {
		t.Fatalf("expected ErrLastRootProtected on disable, got %v", err)
	}
	// 不能被删除。
	if err := deleteUser(root.ID); err != ErrLastRootProtected {
		t.Fatalf("expected ErrLastRootProtected on delete, got %v", err)
	}

	// 有第二个管理员后,原管理员可以降级。
	if _, err := createUser("admin2", "adminpass1", RoleAdmin); err != nil {
		t.Fatalf("createUser admin2: %v", err)
	}
	if err := setUserRole(root.ID, RoleUser); err != nil {
		t.Fatalf("demote with backup admin should succeed: %v", err)
	}
}

func TestMigrateRootUserFromLegacyAuth(t *testing.T) {
	setupUserTestDB(t)

	// 模拟旧的单管理员部署:已 setup 的 WebAuthSettings + 若干存量歌单(user_id=0)。
	hash, _ := bcrypt.GenerateFromPassword([]byte("legacypass1"), bcrypt.DefaultCost)
	if err := core.SaveWebAuthSettings(core.WebAuthSettings{
		Username:      "legacyadmin",
		PasswordHash:  string(hash),
		SessionSecret: "sekret",
	}); err != nil {
		t.Fatalf("SaveWebAuthSettings: %v", err)
	}
	for i := 0; i < 3; i++ {
		if err := db.Create(&Collection{Name: "old", Kind: collectionKindManual, ContentType: collectionContentPlaylist, Source: "local"}).Error; err != nil {
			t.Fatalf("seed collection: %v", err)
		}
	}

	// 重新跑迁移(InitDB 已在 setup 时跑过一次但当时无 legacy auth;这里手动再触发)。
	if err := migrateRootUserAndOwnership(); err != nil {
		t.Fatalf("migrateRootUserAndOwnership: %v", err)
	}

	root, err := findUserByUsername("legacyadmin")
	if err != nil {
		t.Fatalf("root user should exist after migration: %v", err)
	}
	if !root.isAdmin() {
		t.Fatal("migrated root should be admin")
	}
	if !verifyPassword(root.PasswordHash, "legacypass1") {
		t.Fatal("migrated root should keep legacy password")
	}

	var orphans int64
	db.Model(&Collection{}).Where("user_id = 0 OR user_id IS NULL").Count(&orphans)
	if orphans != 0 {
		t.Fatalf("expected all collections backfilled to root, got %d orphans", orphans)
	}
	var owned int64
	db.Model(&Collection{}).Where("user_id = ?", root.ID).Count(&owned)
	if owned != 3 {
		t.Fatalf("expected 3 collections owned by root, got %d", owned)
	}

	// 幂等:再次迁移不报错、不重复建用户。
	if err := migrateRootUserAndOwnership(); err != nil {
		t.Fatalf("second migrate should be idempotent: %v", err)
	}
	n, _ := countUsers()
	if n != 1 {
		t.Fatalf("expected exactly 1 user after idempotent migrate, got %d", n)
	}
}

func TestDownloadRecordOwnership(t *testing.T) {
	setupUserTestDB(t)
	alice, _ := createUser("alice", "alicepass1", RoleUser)
	bob, _ := createUser("bob", "bobpass1", RoleUser)

	// 两人都下了同一首歌(共享文件),各自下了一首独占。
	if err := recordDownload(alice.ID, "shared.mp3", "qq", "1", "Shared", "X"); err != nil {
		t.Fatalf("record: %v", err)
	}
	if err := recordDownload(bob.ID, "shared.mp3", "qq", "1", "Shared", "X"); err != nil {
		t.Fatalf("record: %v", err)
	}
	if err := recordDownload(alice.ID, "alice-only.mp3", "qq", "2", "A", "X"); err != nil {
		t.Fatalf("record: %v", err)
	}

	// 幂等:重复登记不报错。
	if err := recordDownload(alice.ID, "shared.mp3", "qq", "1", "Shared", "X"); err != nil {
		t.Fatalf("idempotent record: %v", err)
	}

	aliceSet, err := downloadedRelPathsForUser(alice.ID)
	if err != nil {
		t.Fatalf("downloadedRelPathsForUser: %v", err)
	}
	if len(aliceSet) != 2 {
		t.Fatalf("alice should have 2 records, got %d", len(aliceSet))
	}
	bobSet, _ := downloadedRelPathsForUser(bob.ID)
	if len(bobSet) != 1 {
		t.Fatalf("bob should have 1 record, got %d", len(bobSet))
	}
	if _, ok := bobSet["alice-only.mp3"]; ok {
		t.Fatal("bob must not see alice-only file")
	}

	// alice 从自己库移除 shared.mp3 → 文件仍被 bob 引用。
	stillRef, err := deleteDownloadRecordForUser(alice.ID, "shared.mp3")
	if err != nil {
		t.Fatalf("deleteDownloadRecordForUser: %v", err)
	}
	if !stillRef {
		t.Fatal("shared.mp3 should still be referenced by bob")
	}
	// bob 也移除 → 不再被引用。
	stillRef, _ = deleteDownloadRecordForUser(bob.ID, "shared.mp3")
	if stillRef {
		t.Fatal("shared.mp3 should no longer be referenced")
	}
}

package web

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestPostgresInitMigratesLegacySQLite(t *testing.T) {
	dsn := os.Getenv("MUSIC_DL_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set MUSIC_DL_TEST_POSTGRES_DSN to run PostgreSQL migration integration test")
	}

	pg, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open postgres: %v", err)
	}
	dropAllPostgresTestTables(t, pg)
	t.Cleanup(func() { dropAllPostgresTestTables(t, pg) })

	baseDir := t.TempDir()
	legacyPath := filepath.Join(baseDir, "settings.db")
	legacy, err := gorm.Open(sqlite.Open(legacyPath), &gorm.Config{})
	if err != nil {
		t.Fatalf("open legacy sqlite: %v", err)
	}
	if err := legacy.AutoMigrate(&User{}, &Collection{}, &SavedSong{}, &DownloadRecord{}, &userPrefRow{}, &searchCacheRow{}, &searchHistoryRow{}, &playHistoryRow{}, &qualityCacheRow{}); err != nil {
		t.Fatalf("migrate legacy sqlite: %v", err)
	}
	user := User{ID: 3, Username: "root", PasswordHash: "!", Role: RoleAdmin}
	if err := legacy.Create(&user).Error; err != nil {
		t.Fatalf("seed user: %v", err)
	}
	collection := Collection{ID: 8, UserID: user.ID, Name: "Legacy", Kind: collectionKindManual, ContentType: collectionContentPlaylist, Source: "local"}
	if err := legacy.Create(&collection).Error; err != nil {
		t.Fatalf("seed collection: %v", err)
	}
	if err := legacy.Create(&SavedSong{ID: 11, CollectionID: collection.ID, SongID: "s1", Source: "qq", Name: "Song"}).Error; err != nil {
		t.Fatalf("seed song: %v", err)
	}
	if err := legacy.Create(&qualityCacheRow{Key: "cache-key", SongID: "s1", Source: "qq", Valid: true, SizeBytes: 4_000_000, SizeText: "3.8 MB", Bitrate: "320 kbps", BitrateNum: 320, CheckedAt: time.Now()}).Error; err != nil {
		t.Fatalf("seed quality cache: %v", err)
	}
	if sqlDB, err := legacy.DB(); err == nil {
		_ = sqlDB.Close()
	}

	t.Setenv("MUSIC_DL_DATABASE_DRIVER", "postgres")
	t.Setenv("MUSIC_DL_DATABASE_DSN", dsn)
	t.Setenv("MUSIC_DL_LEGACY_SQLITE_DB", legacyPath)
	resetCollectionStateForTest()
	t.Cleanup(resetCollectionStateForTest)

	InitDB()

	var users int64
	if err := db.Model(&User{}).Count(&users).Error; err != nil {
		t.Fatalf("count migrated users: %v", err)
	}
	if users != 1 {
		t.Fatalf("migrated user count = %d, want 1", users)
	}
	var songs int64
	if err := db.Model(&SavedSong{}).Where("song_id = ?", "s1").Count(&songs).Error; err != nil {
		t.Fatalf("count migrated songs: %v", err)
	}
	if songs != 1 {
		t.Fatalf("migrated song count = %d, want 1", songs)
	}
	var qualityRows int64
	if err := db.Model(&qualityCacheRow{}).Where("key = ?", "cache-key").Count(&qualityRows).Error; err != nil {
		t.Fatalf("count migrated quality cache: %v", err)
	}
	if qualityRows != 1 {
		t.Fatalf("migrated quality cache rows = %d, want 1", qualityRows)
	}
}

func dropAllPostgresTestTables(t *testing.T, db *gorm.DB) {
	t.Helper()
	if err := db.Migrator().DropTable(
		&qualityCacheRow{},
		&playHistoryRow{},
		&searchHistoryRow{},
		&searchCacheRow{},
		&userPrefRow{},
		&DownloadRecord{},
		&SavedSong{},
		&Collection{},
		&User{},
	); err != nil {
		t.Fatalf("drop postgres test tables: %v", err)
	}
}

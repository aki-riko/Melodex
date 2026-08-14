package web

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

var testUserID uint

func resetCollectionStateForTest() {
	if db != nil {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	}
	db = nil
	invalidateLocalMusicScanCache()
	localMusicMetaCacheMu.Lock()
	localMusicMetaCache = map[string]*localMusicTrack{}
	localMusicMetaCacheMu.Unlock()
	apiCacheRefreshFlight = sync.Map{}
	searchCacheRefreshInFlight = sync.Map{}
	qualityWarmInFlight = sync.Map{}
	apiCacheLastGC = time.Time{}
	searchCacheLastGC = time.Time{}
	qualityCacheLastGC = time.Time{}
	core.ResetConfigStateForTest()
}

func initCollectionDBForTest(t *testing.T) {
	t.Helper()
	root := t.TempDir()
	t.Setenv("MUSIC_DL_CONFIG_DB", filepath.Join(root, "data", "settings.db"))
	t.Setenv("MUSIC_DL_FAVORITES_DB", filepath.Join(root, "data", "favorites.db"))
	t.Setenv("MUSIC_DL_COOKIE_FILE", filepath.Join(root, "data", "cookies.json"))
	resetCollectionStateForTest()
	t.Cleanup(resetCollectionStateForTest)
	InitDB()
	user, err := createUser("tester", "testerpass1", RoleAdmin)
	if err != nil {
		t.Fatalf("create collection test user: %v", err)
	}
	testUserID = user.ID
}

func withTestUser() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(ctxUserID, testUserID)
		c.Set(ctxUserRole, RoleAdmin)
		c.Set(ctxUsername, "tester")
		c.Next()
	}
}

func newCollectionTestRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	group := router.Group(RoutePrefix)
	group.Use(withTestUser())
	RegisterCollectionRoutes(group)
	return router
}

func TestUnifiedCollectionDatabaseContract(t *testing.T) {
	root := t.TempDir()
	settingsPath := filepath.Join(root, "data", "settings.db")
	legacyPath := filepath.Join(root, "data", "favorites.db")
	t.Setenv("MUSIC_DL_CONFIG_DB", settingsPath)
	t.Setenv("MUSIC_DL_FAVORITES_DB", legacyPath)
	resetCollectionStateForTest()
	t.Cleanup(resetCollectionStateForTest)
	InitDB()
	if err := db.Create(&Collection{Name: "Unified DB"}).Error; err != nil {
		t.Fatalf("create collection: %v", err)
	}
	if _, err := os.Stat(settingsPath); err != nil {
		t.Fatalf("unified database missing: %v", err)
	}
	if _, err := os.Stat(legacyPath); !os.IsNotExist(err) {
		t.Fatalf("unused legacy database exists: %v", err)
	}
	verificationDB, err := gorm.Open(sqlite.Open(settingsPath), &gorm.Config{})
	if err != nil {
		t.Fatalf("open unified database independently: %v", err)
	}
	if handle, err := verificationDB.DB(); err == nil {
		defer handle.Close()
	}
	var count int64
	if err := verificationDB.Model(&Collection{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("persisted collection count = %d, err=%v", count, err)
	}
}

func TestLegacyCollectionDatabaseMigrationContract(t *testing.T) {
	root := t.TempDir()
	settingsPath := filepath.Join(root, "data", "settings.db")
	legacyPath := filepath.Join(root, "data", "favorites.db")
	t.Setenv("MUSIC_DL_CONFIG_DB", settingsPath)
	t.Setenv("MUSIC_DL_FAVORITES_DB", legacyPath)
	resetCollectionStateForTest()
	t.Cleanup(resetCollectionStateForTest)
	if err := os.MkdirAll(filepath.Dir(legacyPath), 0o755); err != nil {
		t.Fatalf("create legacy database directory: %v", err)
	}
	legacyDB, err := gorm.Open(sqlite.Open(legacyPath), &gorm.Config{})
	if err != nil {
		t.Fatalf("open legacy database: %v", err)
	}
	legacyHandle, err := legacyDB.DB()
	if err != nil {
		t.Fatalf("load legacy database handle: %v", err)
	}
	if err := legacyDB.AutoMigrate(&Collection{}, &SavedSong{}); err != nil {
		t.Fatalf("create legacy schema: %v", err)
	}
	collection := Collection{ID: 7, Name: "Migrated Playlist"}
	if err := legacyDB.Create(&collection).Error; err != nil {
		t.Fatalf("seed legacy collection: %v", err)
	}
	track := SavedSong{CollectionID: collection.ID, SongID: "song-1", Source: "qq", Name: "Track", Artist: "Artist"}
	if err := legacyDB.Create(&track).Error; err != nil {
		t.Fatalf("seed legacy track: %v", err)
	}
	if err := legacyHandle.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	InitDB()
	var migrated Collection
	if err := db.First(&migrated, collection.ID).Error; err != nil || migrated.Name != collection.Name {
		t.Fatalf("migrated collection = %#v, err=%v", migrated, err)
	}
	var tracks []SavedSong
	if err := db.Where("collection_id = ?", collection.ID).Find(&tracks).Error; err != nil || len(tracks) != 1 || tracks[0].SongID != track.SongID || tracks[0].Source != track.Source {
		t.Fatalf("migrated tracks = %#v, err=%v", tracks, err)
	}
	if _, err := os.Stat(legacyPath); !os.IsNotExist(err) {
		t.Fatalf("legacy database was not removed: %v", err)
	}
}

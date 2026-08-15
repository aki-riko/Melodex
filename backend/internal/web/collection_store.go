package web

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var db *gorm.DB

func InitDB() {
	connection, err := core.OpenAppDatabase()
	if err != nil {
		panic("Failed to connect to database: " + err.Error())
	}
	db = connection
	models := []interface{}{
		&Collection{}, &SavedSong{}, &User{}, &DownloadRecord{}, &userPrefRow{},
		&searchCacheRow{}, &apiCacheRow{}, &searchHistoryRow{}, &playHistoryRow{},
		&qualityCacheRow{}, &DesktopLyricsDevice{},
	}
	if err := db.AutoMigrate(models...); err != nil {
		panic("Failed to migrate database: " + err.Error())
	}

	legacyUnifiedPath := filepath.Clean(core.LegacySQLiteDBPath())
	if core.IsPostgresDB(db) {
		if err := migrateLegacySQLiteWebData(); err != nil {
			panic("Failed to migrate legacy SQLite database: " + err.Error())
		}
	}
	steps := []struct {
		name string
		run  func() error
	}{
		{"legacy favorites", func() error { return migrateLegacyFavorites(legacyUnifiedPath) }},
		{"collection defaults", backfillCollectionDefaults},
		{"multi-user ownership", migrateRootUserAndOwnership},
		{"favorite unique index", ensureFavoriteUniqueIndex},
	}
	for _, step := range steps {
		if err := step.run(); err != nil {
			panic(fmt.Sprintf("Failed to migrate %s: %v", step.name, err))
		}
	}
}

func CloseDB() {
	if db == nil {
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		log.Printf("[database] resolve connection for close: %v", err)
		return
	}
	if err := sqlDB.Close(); err != nil {
		log.Printf("[database] close connection: %v", err)
	}
}

func ensureFavoriteUniqueIndex() error {
	var duplicateGroups []struct {
		UserID uint
		KeepID uint `gorm:"column:keep_id"`
	}
	result := db.Raw(
		"SELECT user_id, MIN(id) AS keep_id FROM collections WHERE kind = ? GROUP BY user_id HAVING COUNT(*) > 1",
		collectionKindFavorite,
	).Scan(&duplicateGroups)
	if result.Error != nil {
		return result.Error
	}
	for _, group := range duplicateGroups {
		var duplicates []uint
		if err := db.Model(&Collection{}).
			Where("kind = ? AND user_id = ? AND id <> ?", collectionKindFavorite, group.UserID, group.KeepID).
			Pluck("id", &duplicates).Error; err != nil {
			return err
		}
		for _, duplicateID := range duplicates {
			if err := mergeFavoriteCollectionSongs(group.KeepID, duplicateID); err != nil {
				return err
			}
		}
	}
	return db.Exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_fav_user ON collections(user_id) WHERE kind = 'favorite'").Error
}

func mergeFavoriteCollectionSongs(targetID, duplicateID uint) error {
	return db.Transaction(func(tx *gorm.DB) error {
		var songs []SavedSong
		if err := tx.Where("collection_id = ?", duplicateID).Find(&songs).Error; err != nil {
			return err
		}
		for _, song := range songs {
			copy := song
			copy.ID = 0
			copy.CollectionID = targetID
			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&copy).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("collection_id = ?", duplicateID).Delete(&SavedSong{}).Error; err != nil {
			return err
		}
		return tx.Delete(&Collection{}, duplicateID).Error
	})
}

func legacyFavoritesDBPath() string {
	return firstNonEmpty(os.Getenv("MUSIC_DL_FAVORITES_DB"), legacyFavoritesDBFile)
}

func migrateLegacyFavorites(unifiedPath string) error {
	legacyPath := filepath.Clean(legacyFavoritesDBPath())
	if legacyPath == "" || legacyPath == filepath.Clean(unifiedPath) {
		return nil
	}
	exists, err := regularFileExists(legacyPath)
	if err != nil || !exists {
		return err
	}
	var existing int64
	if err = db.Model(&Collection{}).Count(&existing).Error; err != nil || existing > 0 {
		return err
	}
	collections, songs, err := readLegacyFavorites(legacyPath)
	if err != nil {
		return err
	}
	if len(collections) > 0 || len(songs) > 0 {
		if err := restoreLegacyCollectionRows(collections, songs); err != nil {
			return err
		}
	}
	return removeLegacyFavoritesFiles(legacyPath)
}

func restoreLegacyCollectionRows(collections []Collection, songs []SavedSong) error {
	return db.Transaction(func(tx *gorm.DB) error {
		if len(collections) != 0 {
			result := tx.Create(&collections)
			if result.Error != nil {
				return result.Error
			}
		}
		for index := range songs {
			songs[index].ID = 0
		}
		if len(songs) == 0 {
			return nil
		}
		ignoreDuplicates := clause.OnConflict{DoNothing: true}
		return tx.Clauses(ignoreDuplicates).Create(&songs).Error
	})
}

func regularFileExists(path string) (bool, error) {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return !info.IsDir(), nil
}

func readLegacyFavorites(path string) ([]Collection, []SavedSong, error) {
	legacy, err := gorm.Open(
		sqlite.Open(path+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"),
		&gorm.Config{},
	)
	if err != nil {
		return nil, nil, err
	}
	sqlDB, err := legacy.DB()
	if err != nil {
		return nil, nil, err
	}
	closeWith := func(err error) ([]Collection, []SavedSong, error) {
		if closeErr := sqlDB.Close(); err == nil {
			err = closeErr
		}
		return nil, nil, err
	}
	if !legacy.Migrator().HasTable(&Collection{}) {
		return closeWith(nil)
	}
	var collections []Collection
	if err := legacy.Order("id ASC").Find(&collections).Error; err != nil {
		return closeWith(err)
	}
	var songs []SavedSong
	if legacy.Migrator().HasTable(&SavedSong{}) {
		if err := legacy.Order("id ASC").Find(&songs).Error; err != nil {
			return closeWith(err)
		}
	}
	if err := sqlDB.Close(); err != nil {
		return nil, nil, err
	}
	return collections, songs, nil
}

func backfillCollectionDefaults() error {
	updates := []struct {
		column string
		value  string
	}{
		{"kind", collectionKindManual},
		{"content_type", collectionContentPlaylist},
		{"source", localMusicSource},
	}
	for _, update := range updates {
		query := fmt.Sprintf("UPDATE collections SET %s = ? WHERE %s = '' OR %s IS NULL", update.column, update.column, update.column)
		if err := db.Exec(query, update.value).Error; err != nil {
			return err
		}
	}
	return nil
}

func removeLegacyFavoritesFiles(legacyPath string) error {
	for _, suffix := range []string{"", "-shm", "-wal", "-journal"} {
		if err := os.Remove(legacyPath + suffix); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func loadOwnedCollection(collectionID string, userID uint) (*Collection, error) {
	if userID == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	var collection Collection
	err := db.Where("id = ? AND user_id = ?", collectionID, userID).First(&collection).Error
	if err != nil {
		return nil, err
	}
	return &collection, nil
}

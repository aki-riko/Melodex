package web

import (
	"github.com/aki-riko/Melodex/backend/core"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func migrateLegacySQLiteWebData() error {
	if db == nil || !core.IsPostgresDB(db) {
		return nil
	}
	legacyPath := core.LegacySQLiteDBPath()
	if legacyPath == "" {
		return nil
	}
	exists, err := regularFileExists(legacyPath)
	if err != nil || !exists {
		return err
	}

	legacyDB, closeLegacy, err := openLegacySettingsDB(legacyPath)
	if err != nil {
		return err
	}
	defer closeLegacy()

	if err := copyLegacyRows[User](legacyDB, "id ASC"); err != nil {
		return err
	}
	if err := copyLegacyRows[Collection](legacyDB, "id ASC"); err != nil {
		return err
	}
	if err := copyLegacyRows[SavedSong](legacyDB, "id ASC"); err != nil {
		return err
	}
	if err := copyLegacyRows[DownloadRecord](legacyDB, "id ASC"); err != nil {
		return err
	}
	if err := copyLegacyRows[userPrefRow](legacyDB, "user_id ASC"); err != nil {
		return err
	}
	if err := copyLegacyRows[searchCacheRow](legacyDB, "created_at ASC"); err != nil {
		return err
	}
	if err := copyLegacyRows[apiCacheRow](legacyDB, "created_at ASC"); err != nil {
		return err
	}
	if err := copyLegacyRows[searchHistoryRow](legacyDB, "id ASC"); err != nil {
		return err
	}
	if err := copyLegacyRows[playHistoryRow](legacyDB, "id ASC"); err != nil {
		return err
	}
	if err := copyLegacyRows[qualityCacheRow](legacyDB, "checked_at ASC"); err != nil {
		return err
	}

	return resetPostgresSequences()
}

func openLegacySettingsDB(path string) (*gorm.DB, func(), error) {
	dsn := path + "?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	legacyDB, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		return nil, func() {}, err
	}
	close := func() {}
	if sqlDB, sqlErr := legacyDB.DB(); sqlErr == nil {
		close = func() { _ = sqlDB.Close() }
	}
	return legacyDB, close, nil
}

func copyLegacyRows[T any](legacyDB *gorm.DB, order string) error {
	var model T
	if !legacyDB.Migrator().HasTable(&model) {
		return nil
	}
	var existing int64
	if err := db.Model(&model).Count(&existing).Error; err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}
	var rows []T
	if err := legacyDB.Order(order).Find(&rows).Error; err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	return db.Clauses(clause.OnConflict{DoNothing: true}).Create(&rows).Error
}

func resetPostgresSequences() error {
	sequences := []struct {
		table  string
		column string
	}{
		{"users", "id"},
		{"collections", "id"},
		{"saved_songs", "id"},
		{"download_records", "id"},
		{"search_history_rows", "id"},
		{"play_history_rows", "id"},
	}
	for _, seq := range sequences {
		if err := db.Exec(
			`SELECT setval(pg_get_serial_sequence(?, ?), COALESCE((SELECT MAX(`+seq.column+`) FROM `+seq.table+`), 1), (SELECT COUNT(*) FROM `+seq.table+`) > 0)`,
			seq.table,
			seq.column,
		).Error; err != nil {
			return err
		}
	}
	return nil
}

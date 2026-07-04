package web

import (
	"os"

	"github.com/glebarez/sqlite"
	"github.com/guohuiyuan/go-music-dl/core"
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
	if _, err := os.Stat(legacyPath); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	legacyDB, err := gorm.Open(sqlite.Open(legacyPath+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"), &gorm.Config{})
	if err != nil {
		return err
	}
	sqlDB, err := legacyDB.DB()
	if err == nil {
		defer sqlDB.Close()
	}

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

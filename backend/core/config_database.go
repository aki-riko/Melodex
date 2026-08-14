package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const ConfigDBFile = "data/settings.db"

type configKV struct {
	UpdatedAt time.Time `gorm:"autoUpdateTime"`
	Key       string    `gorm:"primaryKey;size:128"`
	Value     string    `gorm:"type:text;not null"`
}

type cookieEntry struct {
	UpdatedAt time.Time `gorm:"autoUpdateTime"`
	Source    string    `gorm:"primaryKey;size:64"`
	Value     string    `gorm:"type:text;not null"`
}

var (
	configDB      *gorm.DB
	configInit    sync.Once
	configInitErr error
)

func ConfigDBPath() string {
	if configured := strings.TrimSpace(os.Getenv("MUSIC_DL_CONFIG_DB")); configured != "" {
		return filepath.Clean(configured)
	}
	return filepath.Clean(ConfigDBFile)
}

func configDBPath() string {
	return ConfigDBPath()
}

func legacyCookieFilePath() string {
	if configured := strings.TrimSpace(os.Getenv("MUSIC_DL_COOKIE_FILE")); configured != "" {
		return filepath.Clean(configured)
	}
	return filepath.Clean(CookieFile)
}

func ResetConfigStateForTest() {
	closeConfigDatabase()
	configDB, configInitErr, configInit = nil, nil, sync.Once{}
	CM.mu.Lock()
	CM.cookies = make(map[string]string)
	CM.mu.Unlock()
}

func closeConfigDatabase() {
	if configDB == nil {
		return
	}
	sqlDB, err := configDB.DB()
	if err != nil {
		log.Printf("[config] resolve database for close: %v", err)
		return
	}
	if err := sqlDB.Close(); err != nil {
		log.Printf("[config] close database: %v", err)
	}
}

func ensureConfigDB() error {
	configInit.Do(func() {
		configDB, configInitErr = OpenAppDatabase()
		if configInitErr != nil {
			return
		}
		if configInitErr = configDB.AutoMigrate(&configKV{}, &cookieEntry{}); configInitErr != nil {
			return
		}
		if IsPostgresDB(configDB) {
			configInitErr = migrateLegacyConfigSQLite()
			if configInitErr != nil {
				return
			}
		}
		configInitErr = migrateLegacyCookies()
	})
	return configInitErr
}

func migrateLegacyConfigSQLite() error {
	path := LegacySQLiteDBPath()
	if path == "" {
		return nil
	}
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	legacy, err := gorm.Open(sqlite.Open(path+"?_pragma=busy_timeout(5000)"), &gorm.Config{})
	if err != nil {
		return err
	}
	sqlDB, err := legacy.DB()
	if err != nil {
		return err
	}
	defer sqlDB.Close()
	if err := copyRowsWhenDestinationEmpty[configKV](legacy, configDB, "key", []string{"value", "updated_at"}); err != nil {
		return err
	}
	return copyRowsWhenDestinationEmpty[cookieEntry](legacy, configDB, "source", []string{"value", "updated_at"})
}

func copyRowsWhenDestinationEmpty[T any](source, destination *gorm.DB, conflictColumn string, updateColumns []string) error {
	var destinationCount int64
	if err := destination.Model(new(T)).Count(&destinationCount).Error; err != nil || destinationCount > 0 {
		return err
	}
	var rows []T
	if err := source.Find(&rows).Error; err != nil || len(rows) == 0 {
		return err
	}
	return destination.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: conflictColumn}},
		DoUpdates: clause.AssignmentColumns(updateColumns),
	}).Create(&rows).Error
}

func migrateLegacyCookies() error {
	data, err := os.ReadFile(legacyCookieFilePath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var legacy map[string]string
	if err := json.Unmarshal(data, &legacy); err != nil {
		return fmt.Errorf("decode legacy cookies: %w", err)
	}
	if len(legacy) == 0 {
		return nil
	}
	var existing int64
	if err := configDB.Model(&cookieEntry{}).Count(&existing).Error; err != nil || existing > 0 {
		return err
	}
	entries := make([]cookieEntry, 0, len(legacy))
	for source, value := range legacy {
		source, value = strings.TrimSpace(source), strings.TrimSpace(value)
		if source != "" && value != "" {
			entries = append(entries, cookieEntry{Source: source, Value: value})
		}
	}
	if len(entries) == 0 {
		return nil
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Source < entries[j].Source })
	return configDB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "source"}},
		DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"}),
	}).Create(&entries).Error
}

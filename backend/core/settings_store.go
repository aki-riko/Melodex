package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	ConfigDBFile                    = "data/settings.db"
	DefaultWebDownloadDir           = "data/downloads"
	DefaultDownloadFilenameTemplate = "{name} - {artist}"
	DefaultWebAuthUsername          = "admin"
	DefaultWebPageSize              = 30
	DefaultCLIPageSize              = 20
	DefaultWebConcurrency           = 3
	webSettingsKey                  = "web_settings"
	webAuthSettingsKey              = "web_auth_settings"
)

type configKV struct {
	Key       string    `gorm:"primaryKey;size:128"`
	Value     string    `gorm:"type:text;not null"`
	UpdatedAt time.Time `gorm:"autoUpdateTime"`
}

type cookieEntry struct {
	Source    string    `gorm:"primaryKey;size:64"`
	Value     string    `gorm:"type:text;not null"`
	UpdatedAt time.Time `gorm:"autoUpdateTime"`
}

type WebSettings struct {
	EmbedDownload            bool   `json:"embedDownload"`
	DownloadToLocal          bool   `json:"downloadToLocal"`
	DownloadDir              string `json:"downloadDir"`
	DownloadFilenameTemplate string `json:"downloadFilenameTemplate"`
	DisableFloatingLyrics    bool   `json:"disableFloatingLyrics"`
	WebPageSize              int    `json:"webPageSize"`
	CliPageSize              int    `json:"cliPageSize"`
	DownloadConcurrency      int    `json:"downloadConcurrency"`
	AutoSwitchInvalidSources bool   `json:"autoSwitchInvalidSources"`
	VgChangeCover            bool   `json:"vgChangeCover"`
	VgChangeAudio            bool   `json:"vgChangeAudio"`
	VgChangeLyric            bool   `json:"vgChangeLyric"`
	VgExportVideo            bool   `json:"vgExportVideo"`
}

type WebAuthSettings struct {
	Username      string `json:"username"`
	PasswordHash  string `json:"passwordHash"`
	SessionSecret string `json:"sessionSecret"`
}

var (
	configDB      *gorm.DB
	configInit    sync.Once
	configInitErr error
)

func ConfigDBPath() string {
	if configured := strings.TrimSpace(os.Getenv("MUSIC_DL_CONFIG_DB")); configured != "" {
		return configured
	}
	return ConfigDBFile
}

func configDBPath() string {
	return ConfigDBPath()
}

func legacyCookieFilePath() string {
	if configured := strings.TrimSpace(os.Getenv("MUSIC_DL_COOKIE_FILE")); configured != "" {
		return configured
	}
	return CookieFile
}

func ResetConfigStateForTest() {
	closeConfigDatabase()
	configDB = nil
	configInitErr = nil
	configInit = sync.Once{}
	CM.mu.Lock()
	CM.cookies = make(map[string]string)
	CM.mu.Unlock()
}

func closeConfigDatabase() {
	if configDB == nil {
		return
	}
	if sqlDB, err := configDB.DB(); err == nil {
		_ = sqlDB.Close()
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
			if configInitErr = migrateLegacyConfigSQLite(); configInitErr != nil {
				return
			}
		}
		configInitErr = migrateLegacyCookies()
	})
	return configInitErr
}

func migrateLegacyConfigSQLite() error {
	legacyPath := LegacySQLiteDBPath()
	if legacyPath == "" {
		return nil
	}
	if _, err := os.Stat(legacyPath); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	legacyDB, err := gorm.Open(sqlite.Open(legacyPath+"?_pragma=busy_timeout(5000)"), &gorm.Config{})
	if err != nil {
		return err
	}
	if sqlDB, err := legacyDB.DB(); err == nil {
		defer sqlDB.Close()
	}
	if err := copyRowsWhenDestinationEmpty[configKV](legacyDB, configDB, "key", []string{"value", "updated_at"}); err != nil {
		return err
	}
	return copyRowsWhenDestinationEmpty[cookieEntry](legacyDB, configDB, "source", []string{"value", "updated_at"})
}

func copyRowsWhenDestinationEmpty[T any](source, destination *gorm.DB, conflictColumn string, updateColumns []string) error {
	var count int64
	if err := destination.Model(new(T)).Count(&count).Error; err != nil || count != 0 {
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
	data, err := os.ReadFile(filepath.Clean(legacyCookieFilePath()))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var legacy map[string]string
	if err := json.Unmarshal(data, &legacy); err != nil || len(legacy) == 0 {
		return nil
	}
	var count int64
	if err := configDB.Model(&cookieEntry{}).Count(&count).Error; err != nil || count > 0 {
		return err
	}
	entries := make([]cookieEntry, 0, len(legacy))
	for source, value := range legacy {
		if source, value = strings.TrimSpace(source), strings.TrimSpace(value); source != "" && value != "" {
			entries = append(entries, cookieEntry{Source: source, Value: value})
		}
	}
	if len(entries) == 0 {
		return nil
	}
	return configDB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "source"}},
		DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"}),
	}).Create(&entries).Error
}

func defaultWebSettings() WebSettings {
	return normalizeWebSettings(WebSettings{
		EmbedDownload:            true,
		DownloadDir:              DefaultWebDownloadDir,
		DownloadFilenameTemplate: DefaultDownloadFilenameTemplate,
		WebPageSize:              DefaultWebPageSize,
		CliPageSize:              DefaultCLIPageSize,
		DownloadConcurrency:      DefaultWebConcurrency,
		AutoSwitchInvalidSources: true,
	})
}

func normalizeWebSettings(settings WebSettings) WebSettings {
	settings.DownloadDir = strings.TrimSpace(settings.DownloadDir)
	if settings.DownloadDir == "" {
		settings.DownloadDir = DefaultWebDownloadDir
	}
	settings.DownloadDir = normalizeWebDownloadDir(settings.DownloadDir)
	settings.DownloadFilenameTemplate = strings.TrimSpace(settings.DownloadFilenameTemplate)
	if settings.DownloadFilenameTemplate == "" {
		settings.DownloadFilenameTemplate = DefaultDownloadFilenameTemplate
	}
	if settings.WebPageSize <= 0 {
		settings.WebPageSize = DefaultWebPageSize
	}
	if settings.CliPageSize <= 0 {
		settings.CliPageSize = DefaultCLIPageSize
	}
	if settings.DownloadConcurrency <= 0 {
		settings.DownloadConcurrency = DefaultWebConcurrency
	}
	settings.DownloadConcurrency = min(5, max(1, settings.DownloadConcurrency))
	return settings
}

func normalizeWebDownloadDir(directory string) string {
	cleaned := filepath.Clean(directory)
	if filepath.IsAbs(cleaned) || strings.HasPrefix(cleaned, `\\`) {
		return cleaned
	}
	return filepath.ToSlash(cleaned)
}

func defaultWebAuthSettings() WebAuthSettings {
	return WebAuthSettings{Username: DefaultWebAuthUsername}
}

func normalizeWebAuthSettings(settings WebAuthSettings) WebAuthSettings {
	settings.Username = strings.TrimSpace(settings.Username)
	if settings.Username == "" {
		settings.Username = DefaultWebAuthUsername
	}
	settings.PasswordHash = strings.TrimSpace(settings.PasswordHash)
	settings.SessionSecret = strings.TrimSpace(settings.SessionSecret)
	return settings
}

func GetWebSettings() WebSettings {
	settings, err := readJSONConfig(webSettingsKey, defaultWebSettings(), normalizeWebSettings)
	if err != nil {
		return defaultWebSettings()
	}
	return settings
}

func SaveWebSettings(settings WebSettings) error {
	return writeJSONConfig(webSettingsKey, normalizeWebSettings(settings))
}

func GetWebAuthSettings() (WebAuthSettings, error) {
	return readJSONConfig(webAuthSettingsKey, defaultWebAuthSettings(), normalizeWebAuthSettings)
}

func SaveWebAuthSettings(settings WebAuthSettings) error {
	return writeJSONConfig(webAuthSettingsKey, normalizeWebAuthSettings(settings))
}

func readJSONConfig[T any](key string, defaults T, normalize func(T) T) (T, error) {
	if err := ensureConfigDB(); err != nil {
		return defaults, err
	}
	var row configKV
	if err := configDB.Where("key = ?", key).Limit(1).Find(&row).Error; err != nil {
		return defaults, err
	}
	if row.Key == "" {
		return defaults, nil
	}
	value := defaults
	if err := json.Unmarshal([]byte(row.Value), &value); err != nil {
		return defaults, err
	}
	return normalize(value), nil
}

func writeJSONConfig[T any](key string, value T) error {
	if err := ensureConfigDB(); err != nil {
		return err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return upsertConfigValue(key, string(encoded))
}

func GetConfigValue(key string) (string, error) {
	if err := ensureConfigDB(); err != nil {
		return "", err
	}
	var row configKV
	if err := configDB.Where("key = ?", key).Limit(1).Find(&row).Error; err != nil {
		return "", err
	}
	return row.Value, nil
}

func SetConfigValue(key, value string) error {
	if err := ensureConfigDB(); err != nil {
		return err
	}
	return upsertConfigValue(key, value)
}

func upsertConfigValue(key, value string) error {
	return configDB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"}),
	}).Create(&configKV{Key: key, Value: value}).Error
}

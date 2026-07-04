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
	DefaultUpdateRepoURL            = "https://github.com/guohuiyuan/go-music-dl"
	DefaultGithubProxyURL           = "https://edgeone.gh-proxy.com"
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
	AutoCheckUpdate          bool   `json:"autoCheckUpdate"`
	AutoSwitchInvalidSources bool   `json:"autoSwitchInvalidSources"`
	UpdateRepoURL            string `json:"updateRepoUrl"`
	GithubProxyEnabled       bool   `json:"githubProxyEnabled"`
	GithubProxyURL           string `json:"githubProxyUrl"`
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

func configDBPath() string {
	if path := strings.TrimSpace(os.Getenv("MUSIC_DL_CONFIG_DB")); path != "" {
		return path
	}
	return ConfigDBFile
}

// ResetConfigStateForTest 重置 config DB 单例与内存 cookie,供其他包的测试在切换
// 临时 settings.db 后调用(InitDB 与 GetWebAuthSettings 等共享同一 configDB 单例)。
// 仅用于测试。
func ResetConfigStateForTest() {
	if configDB != nil {
		if sqlDB, err := configDB.DB(); err == nil {
			_ = sqlDB.Close()
		}
	}
	configDB = nil
	configInitErr = nil
	configInit = sync.Once{}

	CM.mu.Lock()
	CM.cookies = make(map[string]string)
	CM.mu.Unlock()
}

// ConfigDBPath returns the canonical SQLite file used by the app.
func ConfigDBPath() string {
	return configDBPath()
}

func legacyCookieFilePath() string {
	if path := strings.TrimSpace(os.Getenv("MUSIC_DL_COOKIE_FILE")); path != "" {
		return path
	}
	return CookieFile
}

func ensureConfigDB() error {
	configInit.Do(func() {
		db, err := OpenAppDatabase()
		if err != nil {
			configInitErr = err
			return
		}

		if err := db.AutoMigrate(&configKV{}, &cookieEntry{}); err != nil {
			configInitErr = err
			return
		}

		configDB = db
		if IsPostgresDB(configDB) {
			if err := migrateLegacyConfigSQLite(); err != nil {
				configInitErr = err
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
	sqlDB, err := legacyDB.DB()
	if err == nil {
		defer sqlDB.Close()
	}

	if err := copyConfigRowsFromSQLite(legacyDB); err != nil {
		return err
	}
	return copyCookieRowsFromSQLite(legacyDB)
}

func copyConfigRowsFromSQLite(legacyDB *gorm.DB) error {
	var existing int64
	if err := configDB.Model(&configKV{}).Count(&existing).Error; err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}
	var rows []configKV
	if err := legacyDB.Find(&rows).Error; err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	return configDB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"}),
	}).Create(&rows).Error
}

func copyCookieRowsFromSQLite(legacyDB *gorm.DB) error {
	var existing int64
	if err := configDB.Model(&cookieEntry{}).Count(&existing).Error; err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}
	var rows []cookieEntry
	if err := legacyDB.Find(&rows).Error; err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	return configDB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "source"}},
		DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"}),
	}).Create(&rows).Error
}

func migrateLegacyCookies() error {
	legacyPath := filepath.Clean(legacyCookieFilePath())
	data, err := os.ReadFile(legacyPath)
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
	if err := configDB.Model(&cookieEntry{}).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	entries := make([]cookieEntry, 0, len(legacy))
	for source, value := range legacy {
		source = strings.TrimSpace(source)
		value = strings.TrimSpace(value)
		if source == "" || value == "" {
			continue
		}
		entries = append(entries, cookieEntry{Source: source, Value: value})
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
		DownloadToLocal:          false,
		DownloadDir:              DefaultWebDownloadDir,
		DownloadFilenameTemplate: DefaultDownloadFilenameTemplate,
		DisableFloatingLyrics:    false,
		WebPageSize:              DefaultWebPageSize,
		CliPageSize:              DefaultCLIPageSize,
		DownloadConcurrency:      DefaultWebConcurrency,
		AutoCheckUpdate:          true,
		AutoSwitchInvalidSources: true,
		UpdateRepoURL:            DefaultUpdateRepoURL,
		GithubProxyEnabled:       false,
		GithubProxyURL:           DefaultGithubProxyURL,
	})
}

func defaultWebAuthSettings() WebAuthSettings {
	return WebAuthSettings{
		Username: DefaultWebAuthUsername,
	}
}

func normalizeWebSettings(settings WebSettings) WebSettings {
	settings.DownloadDir = strings.TrimSpace(settings.DownloadDir)
	if settings.DownloadDir == "" {
		settings.DownloadDir = DefaultWebDownloadDir
	}
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
	if settings.DownloadConcurrency > 5 {
		settings.DownloadConcurrency = 5
	}
	if settings.DownloadConcurrency < 1 {
		settings.DownloadConcurrency = 1
	}
	settings.UpdateRepoURL = strings.TrimSpace(settings.UpdateRepoURL)
	if settings.UpdateRepoURL == "" {
		settings.UpdateRepoURL = DefaultUpdateRepoURL
	}
	settings.GithubProxyURL = strings.TrimSpace(settings.GithubProxyURL)
	if settings.GithubProxyURL == "" {
		settings.GithubProxyURL = DefaultGithubProxyURL
	}
	settings.DownloadDir = normalizeWebDownloadDir(settings.DownloadDir)
	return settings
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

func normalizeWebDownloadDir(dir string) string {
	cleaned := filepath.Clean(dir)
	if filepath.IsAbs(cleaned) || strings.HasPrefix(cleaned, `\\`) {
		return cleaned
	}
	return filepath.ToSlash(cleaned)
}

func GetWebSettings() WebSettings {
	settings := defaultWebSettings()
	if err := ensureConfigDB(); err != nil {
		return settings
	}

	var row configKV
	if err := configDB.Where("key = ?", webSettingsKey).Limit(1).Find(&row).Error; err != nil {
		return settings
	}
	if row.Key == "" {
		return settings
	}

	if err := json.Unmarshal([]byte(row.Value), &settings); err != nil {
		return defaultWebSettings()
	}
	return normalizeWebSettings(settings)
}

func SaveWebSettings(settings WebSettings) error {
	if err := ensureConfigDB(); err != nil {
		return err
	}

	settings = normalizeWebSettings(settings)
	data, err := json.Marshal(settings)
	if err != nil {
		return err
	}

	return configDB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"}),
	}).Create(&configKV{
		Key:   webSettingsKey,
		Value: string(data),
	}).Error
}

func GetWebAuthSettings() (WebAuthSettings, error) {
	settings := defaultWebAuthSettings()
	if err := ensureConfigDB(); err != nil {
		return settings, err
	}

	var row configKV
	if err := configDB.Where("key = ?", webAuthSettingsKey).Limit(1).Find(&row).Error; err != nil {
		return settings, err
	}
	if row.Key == "" {
		return settings, nil
	}

	if err := json.Unmarshal([]byte(row.Value), &settings); err != nil {
		return defaultWebAuthSettings(), err
	}
	return normalizeWebAuthSettings(settings), nil
}

func SaveWebAuthSettings(settings WebAuthSettings) error {
	if err := ensureConfigDB(); err != nil {
		return err
	}

	settings = normalizeWebAuthSettings(settings)
	data, err := json.Marshal(settings)
	if err != nil {
		return err
	}

	return configDB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"}),
	}).Create(&configKV{
		Key:   webAuthSettingsKey,
		Value: string(data),
	}).Error
}

// GetConfigValue 读取一个通用配置项(不存在返回空串)。供 web 层存放系统级开关
// (如开放注册)而无需在 core 增加专用类型。
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

// SetConfigValue 写入一个通用配置项。
func SetConfigValue(key, value string) error {
	if err := ensureConfigDB(); err != nil {
		return err
	}
	return configDB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"}),
	}).Create(&configKV{
		Key:   key,
		Value: value,
	}).Error
}

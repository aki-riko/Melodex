package core

import (
	"encoding/json"
	"errors"
	"log"
	"path/filepath"
	"strings"

	"gorm.io/gorm/clause"
)

const (
	DefaultWebDownloadDir           = "data/downloads"
	DefaultDownloadFilenameTemplate = "{name} - {artist}"
	DefaultWebAuthUsername          = "admin"
	DefaultWebPageSize              = 30
	DefaultCLIPageSize              = 20
	DefaultWebConcurrency           = 3
	webSettingsKey                  = "web_settings"
	webAuthSettingsKey              = "web_auth_settings"
)

type WebSettings struct {
	DownloadDir              string `json:"downloadDir"`
	WebPageSize              int    `json:"webPageSize"`
	DownloadFilenameTemplate string `json:"downloadFilenameTemplate"`
	CliPageSize              int    `json:"cliPageSize"`
	EmbedDownload            bool   `json:"embedDownload"`
	VgChangeCover            bool   `json:"vgChangeCover"`
	DownloadConcurrency      int    `json:"downloadConcurrency"`
	DownloadToLocal          bool   `json:"downloadToLocal"`
	VgChangeAudio            bool   `json:"vgChangeAudio"`
	DisableFloatingLyrics    bool   `json:"disableFloatingLyrics"`
	AutoSwitchInvalidSources bool   `json:"autoSwitchInvalidSources"`
	VgChangeLyric            bool   `json:"vgChangeLyric"`
	VgExportVideo            bool   `json:"vgExportVideo"`
}

type WebAuthSettings struct {
	SessionSecret string `json:"sessionSecret"`
	PasswordHash  string `json:"passwordHash"`
	Username      string `json:"username"`
}

func defaultWebSettings() WebSettings {
	return normalizeWebSettings(WebSettings{
		EmbedDownload: true, DownloadDir: DefaultWebDownloadDir,
		DownloadFilenameTemplate: DefaultDownloadFilenameTemplate,
		WebPageSize:              DefaultWebPageSize, CliPageSize: DefaultCLIPageSize,
		DownloadConcurrency: DefaultWebConcurrency, AutoSwitchInvalidSources: true,
	})
}

func normalizeWebSettings(settings WebSettings) WebSettings {
	if settings.DownloadDir = strings.TrimSpace(settings.DownloadDir); settings.DownloadDir == "" {
		settings.DownloadDir = DefaultWebDownloadDir
	}
	settings.DownloadDir = normalizeWebDownloadDir(settings.DownloadDir)
	if settings.DownloadFilenameTemplate = strings.TrimSpace(settings.DownloadFilenameTemplate); settings.DownloadFilenameTemplate == "" {
		settings.DownloadFilenameTemplate = DefaultDownloadFilenameTemplate
	}
	settings.WebPageSize = positiveOrDefault(settings.WebPageSize, DefaultWebPageSize)
	settings.CliPageSize = positiveOrDefault(settings.CliPageSize, DefaultCLIPageSize)
	settings.DownloadConcurrency = min(5, positiveOrDefault(settings.DownloadConcurrency, DefaultWebConcurrency))
	return settings
}

func positiveOrDefault(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	return value
}

func normalizeWebDownloadDir(directory string) string {
	cleaned := filepath.Clean(directory)
	if filepath.IsAbs(cleaned) || strings.HasPrefix(cleaned, `\\`) {
		return cleaned
	}
	return filepath.ToSlash(cleaned)
}

func defaultWebAuthSettings() WebAuthSettings {
	return normalizeWebAuthSettings(WebAuthSettings{})
}

func normalizeWebAuthSettings(settings WebAuthSettings) WebAuthSettings {
	settings.Username = normalizedAuthUsername(settings.Username)
	settings.PasswordHash = strings.TrimSpace(settings.PasswordHash)
	settings.SessionSecret = strings.TrimSpace(settings.SessionSecret)
	return settings
}

func normalizedAuthUsername(username string) string {
	username = strings.TrimSpace(username)
	if username != "" {
		return username
	}
	return DefaultWebAuthUsername
}

func GetWebSettings() WebSettings {
	settings, err := readJSONConfig(webSettingsKey, defaultWebSettings(), normalizeWebSettings)
	if err != nil {
		log.Printf("[config] read web settings, using defaults: %v", err)
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
	value, found, err := readConfigValue(key)
	if err != nil || !found {
		return defaults, err
	}
	decoded := defaults
	if err := json.Unmarshal([]byte(value), &decoded); err != nil {
		return defaults, err
	}
	return normalize(decoded), nil
}

func writeJSONConfig[T any](key string, value T) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return SetConfigValue(key, string(encoded))
}

func GetConfigValue(key string) (string, error) {
	value, _, err := readConfigValue(key)
	return value, err
}

func readConfigValue(key string) (string, bool, error) {
	if err := ensureConfigDB(); err != nil {
		return "", false, err
	}
	var row configKV
	result := configDB.Where("key = ?", strings.TrimSpace(key)).Limit(1).Find(&row)
	if result.Error != nil {
		return "", false, result.Error
	}
	return row.Value, row.Key != "", nil
}

func SetConfigValue(key, value string) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return errors.New("config key is empty")
	}
	if err := ensureConfigDB(); err != nil {
		return err
	}
	conflict := clause.OnConflict{}
	conflict.Columns = []clause.Column{{Name: "key"}}
	conflict.DoUpdates = clause.AssignmentColumns([]string{"value", "updated_at"})
	record := configKV{Key: key, Value: value}
	return configDB.Clauses(conflict).Create(&record).Error
}

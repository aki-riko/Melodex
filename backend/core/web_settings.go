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

// WebSettings 是系统级（全体用户共享）的设置。
//
// ★ 2026-11 全库扫描:删除了 4 个 `Vg*` 字段(VgChangeCover / VgChangeAudio /
// VgChangeLyric / VgExportVideo)。它们是 **videogen 功能的配置**,
// 而 videogen 已于 2026-06 整体剥离(前端组件/引擎/导航删除,
// 后端 RegisterVideogenRoutes 不再注册,只剩一个不挂载的 videogen.go)。
//
// 为什么能安全删:
//
//	· 全库除定义与一处契约测试外**零使用**(grep 已核实);
//	· 持久化走 json.Unmarshal,而 Go 的 encoding/json 对**未知字段是静默忽略**,
//	  所以已部署实例的 settings JSON 里若还留着 "vgChangeCover": true,
//	  读的时候会被丢掉、不会报错,也不会影响其它字段;
//	· 写回时自然不再包含它们,存量数据随着一次保存就干净了。
//
// 留着它们的害处:任何读 WebSettings 的人都会以为"视频生成还有配置入口",
// 从而去找一个不存在的功能 —— 死配置比死代码更误导,因为它出现在结构体里,
// 看起来像是活的能力。
type WebSettings struct {
	DownloadDir              string `json:"downloadDir"`
	WebPageSize              int    `json:"webPageSize"`
	DownloadFilenameTemplate string `json:"downloadFilenameTemplate"`
	CliPageSize              int    `json:"cliPageSize"`
	EmbedDownload            bool   `json:"embedDownload"`
	DownloadConcurrency      int    `json:"downloadConcurrency"`
	DownloadToLocal          bool   `json:"downloadToLocal"`
	DisableFloatingLyrics    bool   `json:"disableFloatingLyrics"`
	AutoSwitchInvalidSources bool   `json:"autoSwitchInvalidSources"`
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

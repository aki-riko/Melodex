package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
)

func resetConfigStateForTest() {
	closeConfigDatabase()
	CM.mu.Lock()
	CM.cookies = map[string]string{}
	CM.mu.Unlock()
	configDB, configInitErr = nil, nil
	configInit = sync.Once{}
}

func isolateConfigStore(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv("MUSIC_DL_CONFIG_DB", filepath.Join(root, "state", "settings.db"))
	t.Setenv("MUSIC_DL_COOKIE_FILE", filepath.Join(root, "state", "cookies.json"))
	resetConfigStateForTest()
	t.Cleanup(resetConfigStateForTest)
	return root
}

func TestConfigStoreMigratesCookiesIntoSQLite(t *testing.T) {
	root := isolateConfigStore(t)
	stateDir := filepath.Join(root, "state")
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		t.Fatalf("create state directory: %v", err)
	}

	legacyCookies := map[string]string{"netease": "foo=bar", "qq": "uin=123"}
	payload, err := json.Marshal(legacyCookies)
	if err != nil {
		t.Fatalf("encode legacy cookie file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "cookies.json"), payload, 0o600); err != nil {
		t.Fatalf("write legacy cookie file: %v", err)
	}

	CM.Load()
	if got := CM.GetAll(); !reflect.DeepEqual(got, legacyCookies) {
		t.Fatalf("migrated cookies = %#v, want %#v", got, legacyCookies)
	}

	CM.SetAll(map[string]string{"netease": "foo=updated", "qq": "", "kugou": "token=456"})
	CM.Save()
	resetConfigStateForTest()
	CM.Load()

	want := map[string]string{"netease": "foo=updated", "kugou": "token=456"}
	if got := CM.GetAll(); !reflect.DeepEqual(got, want) {
		t.Fatalf("persisted cookies = %#v, want %#v", got, want)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "settings.db")); err != nil {
		t.Fatalf("SQLite store was not created: %v", err)
	}
}

func TestWebSettingsDefaultsAndNormalization(t *testing.T) {
	root := isolateConfigStore(t)
	defaults := GetWebSettings()
	wantDefaults := WebSettings{
		EmbedDownload:            true,
		DownloadDir:              normalizeWebDownloadDir(DefaultWebDownloadDir),
		DownloadFilenameTemplate: DefaultDownloadFilenameTemplate,
		WebPageSize:              DefaultWebPageSize,
		CliPageSize:              DefaultCLIPageSize,
		DownloadConcurrency:      DefaultWebConcurrency,
		AutoSwitchInvalidSources: true,
	}
	if !reflect.DeepEqual(defaults, wantDefaults) {
		t.Fatalf("default web settings = %#v, want %#v", defaults, wantDefaults)
	}

	configured := WebSettings{
		DownloadFilenameTemplate: "{artist} - {name}.{ext}",
		WebPageSize:              100,
		EmbedDownload:            true,
		CliPageSize:              120,
		DownloadToLocal:          true,
		DownloadConcurrency:      5,
		DisableFloatingLyrics:    true,
		AutoSwitchInvalidSources: false,
		VgChangeCover:            true,
		VgChangeAudio:            true,
		VgChangeLyric:            true,
		VgExportVideo:            true,
	}
	if err := SaveWebSettings(configured); err != nil {
		t.Fatalf("save configured web settings: %v", err)
	}
	configured.DownloadDir = normalizeWebDownloadDir(DefaultWebDownloadDir)
	if got := GetWebSettings(); !reflect.DeepEqual(got, configured) {
		t.Fatalf("configured web settings = %#v, want %#v", got, configured)
	}

	relativeDir := filepath.Join("downloads", "custom")
	if err := SaveWebSettings(WebSettings{DownloadDir: relativeDir}); err != nil {
		t.Fatalf("save relative download directory: %v", err)
	}
	got := GetWebSettings()
	if got.DownloadDir != normalizeWebDownloadDir(relativeDir) || got.DownloadFilenameTemplate != DefaultDownloadFilenameTemplate {
		t.Fatalf("normalized relative settings = %#v", got)
	}
	if got.WebPageSize != DefaultWebPageSize || got.CliPageSize != DefaultCLIPageSize || got.DownloadConcurrency != DefaultWebConcurrency {
		t.Fatalf("numeric defaults were not restored: %#v", got)
	}
	if got.AutoSwitchInvalidSources || got.DisableFloatingLyrics || got.VgChangeCover || got.VgChangeAudio || got.VgChangeLyric || got.VgExportVideo {
		t.Fatalf("omitted boolean settings were not normalized: %#v", got)
	}

	absoluteDir := filepath.Join(root, "downloads", "absolute")
	if err := SaveWebSettings(WebSettings{DownloadDir: absoluteDir}); err != nil {
		t.Fatalf("save absolute download directory: %v", err)
	}
	if got := GetWebSettings().DownloadDir; got != filepath.Clean(absoluteDir) {
		t.Fatalf("absolute download directory = %q, want %q", got, filepath.Clean(absoluteDir))
	}
}

func TestLegacyWebSettingsEnableAutomaticSourceSwitching(t *testing.T) {
	isolateConfigStore(t)
	payload, err := json.Marshal(map[string]any{"downloadDir": DefaultWebDownloadDir})
	if err != nil {
		t.Fatalf("encode legacy settings: %v", err)
	}
	if err := ensureConfigDB(); err != nil {
		t.Fatalf("initialize config database: %v", err)
	}
	if err := configDB.Save(&configKV{Key: webSettingsKey, Value: string(payload)}).Error; err != nil {
		t.Fatalf("insert legacy settings: %v", err)
	}
	if got := GetWebSettings(); !got.AutoSwitchInvalidSources {
		t.Fatalf("legacy settings did not enable automatic source switching: %#v", got)
	}
}

func TestWebAuthSettingsRoundTrip(t *testing.T) {
	isolateConfigStore(t)
	defaults, err := GetWebAuthSettings()
	if err != nil {
		t.Fatalf("load default auth settings: %v", err)
	}
	if defaults.Username != DefaultWebAuthUsername || defaults.PasswordHash != "" || defaults.SessionSecret != "" {
		t.Fatalf("default auth settings = %#v", defaults)
	}

	want := WebAuthSettings{Username: "owner", PasswordHash: "bcrypt-hash", SessionSecret: "session-secret"}
	if err := SaveWebAuthSettings(want); err != nil {
		t.Fatalf("save auth settings: %v", err)
	}
	got, err := GetWebAuthSettings()
	if err != nil {
		t.Fatalf("reload auth settings: %v", err)
	}
	assertWebAuthSettingsEqual(t, got, want)

	if err := SaveWebAuthSettings(WebAuthSettings{}); err != nil {
		t.Fatalf("save empty auth settings: %v", err)
	}
	got, err = GetWebAuthSettings()
	if err != nil {
		t.Fatalf("reload normalized auth settings: %v", err)
	}
	if got.Username != DefaultWebAuthUsername {
		t.Fatalf("normalized auth username = %q, want %q", got.Username, DefaultWebAuthUsername)
	}
}

func assertWebAuthSettingsEqual(t *testing.T, got, want WebAuthSettings) {
	t.Helper()
	if reflect.DeepEqual(got, want) {
		return
	}
	t.Fatalf("auth settings = %#v, want %#v", got, want)
}

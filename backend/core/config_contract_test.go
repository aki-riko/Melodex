package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
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
	if got.AutoSwitchInvalidSources || got.DisableFloatingLyrics {
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

// TestStaleWebSettingsFieldsAreIgnored 守住"删除字段对存量数据安全"这个前提。
//
// 2026-11 全库扫描删除了 WebSettings 里 4 个 videogen 残留字段
// (vgChangeCover / vgChangeAudio / vgChangeLyric / vgExportVideo)。
// 删除的依据是:持久化走 json.Unmarshal,而 encoding/json 对**未知字段静默忽略**,
// 所以已部署实例的 settings JSON 里若还留着这些键,读取时会被丢掉、不会报错。
//
// ★ 但"依据"不能只写在注释里 —— 它是这次删除的安全性根基。
//
//	若将来有人把实现改成 json.Decoder + DisallowUnknownFields(那会更严格),
//	这条测试会立刻红,提醒他:存量数据会读失败,必须先做迁移。
func TestStaleWebSettingsFieldsAreIgnored(t *testing.T) {
	// 模拟一份"旧版本写下的"配置 JSON:含已删除的 Vg* 键。
	stale := `{"downloadDir":"/data/downloads","webPageSize":50,` +
		`"vgChangeCover":true,"vgChangeAudio":true,` +
		`"vgChangeLyric":true,"vgExportVideo":true,` +
		`"downloadConcurrency":3,"disableFloatingLyrics":true}`

	var decoded WebSettings
	if err := json.Unmarshal([]byte(stale), &decoded); err != nil {
		t.Fatalf("旧配置(含已删除字段)必须能正常反序列化, 实际报错: %v\n"+
			"若这是因为改用了 DisallowUnknownFields,请先给存量数据写迁移再改这条测试。", err)
	}

	// 保留的字段必须被正确读进来(证明不是"整个 JSON 被丢弃")。
	if decoded.WebPageSize != 50 {
		t.Fatalf("webPageSize = %d, want 50", decoded.WebPageSize)
	}
	if decoded.DownloadConcurrency != 3 {
		t.Fatalf("downloadConcurrency = %d, want 3", decoded.DownloadConcurrency)
	}
	if !decoded.DisableFloatingLyrics {
		t.Fatal("disableFloatingLyrics 应被读为 true")
	}

	// 再序列化回去时,已删除的字段不应重新出现。
	encoded, err := json.Marshal(decoded)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	for _, removed := range []string{
		"vgChangeCover", "vgChangeAudio", "vgChangeLyric", "vgExportVideo",
	} {
		if strings.Contains(string(encoded), removed) {
			t.Fatalf("已删除的字段 %q 仍出现在序列化结果里: %s", removed, encoded)
		}
	}
}

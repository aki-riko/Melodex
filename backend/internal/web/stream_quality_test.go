package web

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

// 这组测试锁定「音质自愈」的三条后端保证:
//  1. 副本是有损、在线源能无损时,stream=1 不再被旧副本钉死;
//  2. 在线源解析不到时必须回退到副本(不能为了音质把歌播没);
//  3. /music/downloads 带出 ext/size_bytes,前端才有依据触发升级。

func withOnlineStreamURLProvider(t *testing.T, url string, err error) {
	t.Helper()
	original := onlineStreamURLProvider
	onlineStreamURLProvider = func(*model.Track) (string, error) { return url, err }
	t.Cleanup(func() { onlineStreamURLProvider = original })
}

func streamURLWithExtra(songID, source, name, artist, extra string) string {
	params := "id=" + songID + "&source=" + source + "&name=" + name + "&artist=" + artist + "&stream=1"
	if extra != "" {
		params += "&extra=" + extra
	}
	return RoutePrefix + "/download?" + params
}

func TestStreamCopyLosssyCopyYieldsToOnlineLossless(t *testing.T) {
	setupUserTestDB(t)

	alice, err := createUser("alice-quality", "alicepass1", RoleUser)
	if err != nil {
		t.Fatalf("create alice: %v", err)
	}
	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)

	// 现场:早年无会员时落盘的 128k mp3。
	rel := "晴天 - 周杰伦.mp3"
	oldBytes := []byte("ID3-old-128k-mp3-bytes")
	if err := os.WriteFile(filepath.Join(downloadDir, rel), oldBytes, 0644); err != nil {
		t.Fatalf("write legacy mp3: %v", err)
	}
	if err := recordDownload(alice.ID, rel, "qq", "0039MnYb0qxYhV", "晴天", "周杰伦"); err != nil {
		t.Fatalf("record legacy download: %v", err)
	}

	// 在线源现在能拿无损:必须放弃副本。
	withOnlineStreamURLProvider(t, "https://example.invalid/flac", nil)

	router := musicRouterForUser(alice.ID, RoleUser)
	req := httptest.NewRequest(http.MethodGet,
		streamURLWithExtra("0039MnYb0qxYhV", "qq", "晴天", "周杰伦", `{"has_lossless":"1"}`), nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if got := rec.Header().Get("X-Melodex-Playback-Source"); got == "server" {
		t.Fatalf("losssy server copy must yield to online lossless, still got server copy")
	}
	// 在线代理会因伪 URL 失败,但关键是它没有直接发旧 mp3 的字节。
	if bytes.Contains(rec.Body.Bytes(), []byte("ID3-old-128k")) {
		t.Fatalf("served legacy lossy copy despite online lossless being available")
	}
}

func TestStreamCopyLosssyCopyKeptWhenOnlineUnavailable(t *testing.T) {
	setupUserTestDB(t)

	alice, err := createUser("alice-quality-fallback", "alicepass1", RoleUser)
	if err != nil {
		t.Fatalf("create alice: %v", err)
	}
	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)

	rel := "晴天 - 周杰伦.mp3"
	oldBytes := []byte("ID3-old-128k-mp3-bytes")
	if err := os.WriteFile(filepath.Join(downloadDir, rel), oldBytes, 0644); err != nil {
		t.Fatalf("write legacy mp3: %v", err)
	}
	if err := recordDownload(alice.ID, rel, "qq", "0039MnYb0qxYhV", "晴天", "周杰伦"); err != nil {
		t.Fatalf("record legacy download: %v", err)
	}

	// 在线源解析失败:宁可播旧副本,也不能播不了。
	withOnlineStreamURLProvider(t, "", os.ErrNotExist)

	router := musicRouterForUser(alice.ID, RoleUser)
	req := httptest.NewRequest(http.MethodGet,
		streamURLWithExtra("0039MnYb0qxYhV", "qq", "晴天", "周杰伦", `{"has_lossless":"1"}`), nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("fallback status=%d body=%q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-Melodex-Playback-Source"); got != "server" {
		t.Fatalf("playback source=%q, want server fallback", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), oldBytes) {
		t.Fatalf("fallback body=%q, want legacy copy bytes", rec.Body.Bytes())
	}
}

func TestStreamCopyLosslessCopyStaysPreferred(t *testing.T) {
	setupUserTestDB(t)

	alice, err := createUser("alice-quality-lossless", "alicepass1", RoleUser)
	if err != nil {
		t.Fatalf("create alice: %v", err)
	}
	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)

	rel := "晴天 - 周杰伦.flac"
	flacBytes := []byte("fLaC-lossless-copy-bytes")
	if err := os.WriteFile(filepath.Join(downloadDir, rel), flacBytes, 0644); err != nil {
		t.Fatalf("write flac: %v", err)
	}
	if err := recordDownload(alice.ID, rel, "qq", "0039MnYb0qxYhV", "晴天", "周杰伦"); err != nil {
		t.Fatalf("record flac download: %v", err)
	}

	// 即使在线源声明无损,磁盘已是无损也不必回源(省流量、避免链接过期)。
	withOnlineStreamURLProvider(t, "https://example.invalid/flac", nil)

	router := musicRouterForUser(alice.ID, RoleUser)
	req := httptest.NewRequest(http.MethodGet,
		streamURLWithExtra("0039MnYb0qxYhV", "qq", "晴天", "周杰伦", `{"has_lossless":"1"}`), nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if got := rec.Header().Get("X-Melodex-Playback-Source"); got != "server" {
		t.Fatalf("lossless copy should stay preferred, source=%q", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), flacBytes) {
		t.Fatalf("body=%q, want flac copy", rec.Body.Bytes())
	}
}

// 未声明无损时保持原有"副本优先"语义,不因本改动额外回源。
func TestStreamCopyLossyCopyStaysPreferredWithoutLosslessClaim(t *testing.T) {
	setupUserTestDB(t)

	alice, err := createUser("alice-quality-nolossless", "alicepass1", RoleUser)
	if err != nil {
		t.Fatalf("create alice: %v", err)
	}
	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)

	rel := "晴天 - 周杰伦.mp3"
	oldBytes := []byte("ID3-some-mp3")
	if err := os.WriteFile(filepath.Join(downloadDir, rel), oldBytes, 0644); err != nil {
		t.Fatalf("write mp3: %v", err)
	}
	if err := recordDownload(alice.ID, rel, "qq", "0039MnYb0qxYhV", "晴天", "周杰伦"); err != nil {
		t.Fatalf("record mp3 download: %v", err)
	}
	withOnlineStreamURLProvider(t, "https://example.invalid/flac", nil)

	router := musicRouterForUser(alice.ID, RoleUser)
	req := httptest.NewRequest(http.MethodGet,
		streamURLWithExtra("0039MnYb0qxYhV", "qq", "晴天", "周杰伦", ""), nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if got := rec.Header().Get("X-Melodex-Playback-Source"); got != "server" {
		t.Fatalf("without lossless claim the copy must stay preferred, source=%q", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), oldBytes) {
		t.Fatalf("body=%q, want mp3 copy", rec.Body.Bytes())
	}
}

// /music/downloads 必须带出 ext 与 size_bytes:前端据此判断"磁盘上有损、
// 在线能无损,需要升级",缺这两个字段前端无法做出任何判断。
func TestDownloadsListExposesAudioFileFacts(t *testing.T) {
	setupUserTestDB(t)

	alice, err := createUser("alice-facts", "alicepass1", RoleUser)
	if err != nil {
		t.Fatalf("create alice: %v", err)
	}
	downloadDir := t.TempDir()
	withLocalMusicDownloadDir(t, downloadDir)

	rel := "晴天 - 周杰伦.mp3"
	payloadBytes := []byte("0123456789")
	if err := os.WriteFile(filepath.Join(downloadDir, rel), payloadBytes, 0644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	if err := recordDownload(alice.ID, rel, "qq", "0039MnYb0qxYhV", "晴天", "周杰伦"); err != nil {
		t.Fatalf("record download: %v", err)
	}

	items, err := existingDownloadStatusForUser(alice.ID, false, downloadDir)
	if err != nil {
		t.Fatalf("existingDownloadStatusForUser: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("items=%+v, want 1", items)
	}
	if items[0].Ext != "mp3" {
		t.Fatalf("ext=%q, want mp3", items[0].Ext)
	}
	if items[0].SizeBytes != int64(len(payloadBytes)) {
		t.Fatalf("size_bytes=%d, want %d", items[0].SizeBytes, len(payloadBytes))
	}

	// 这条断言锁的是**线上 JSON 键名**:前端读的是 record.ext / record.size_bytes,
	// 不是 Go 字段名。改成 Ext/SizeBytes 时前端会静默退化为"无证据"。
	encoded, err := json.Marshal(items[0])
	if err != nil {
		t.Fatalf("marshal item: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(encoded, &raw); err != nil {
		t.Fatalf("unmarshal item: %v", err)
	}
	if got, ok := raw["ext"]; !ok || got != "mp3" {
		t.Fatalf(`json key "ext" = %v (present=%v), want "mp3"; payload=%s`, got, ok, encoded)
	}
	if got, ok := raw["size_bytes"]; !ok || got != float64(len(payloadBytes)) {
		t.Fatalf(`json key "size_bytes" = %v (present=%v), want %d; payload=%s`, got, ok, len(payloadBytes), encoded)
	}
}

// shouldStreamFromServerCopy 的纯逻辑表驱动测试。
func TestShouldStreamFromServerCopy(t *testing.T) {
	cases := []struct {
		name    string
		relPath string
		track   *model.Track
		want    bool
	}{
		{"flac copy always preferred", "a.flac", &model.Track{}, true},
		{"wav copy always preferred", "a.wav", &model.Track{Extra: map[string]string{"has_lossless": "1"}}, true},
		{"mp3 copy with lossless claim yields", "a.mp3", &model.Track{Extra: map[string]string{"has_lossless": "1"}}, false},
		{"m4a copy with lossless claim yields", "a.m4a", &model.Track{Extra: map[string]string{"has_lossless": "1"}}, false},
		{"mp3 copy without claim preferred", "a.mp3", &model.Track{}, true},
		{"mp3 copy with nil extra preferred", "a.mp3", &model.Track{Extra: nil}, true},
		{"unknown ext preferred", "a.bin", &model.Track{Extra: map[string]string{"has_lossless": "1"}}, true},
		{"nil track preferred", "a.mp3", nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldStreamFromServerCopy(tc.relPath, tc.track); got != tc.want {
				t.Fatalf("shouldStreamFromServerCopy(%q) = %v, want %v", tc.relPath, got, tc.want)
			}
		})
	}
}

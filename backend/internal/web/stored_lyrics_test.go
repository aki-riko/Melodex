package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStoredLyricsAcrossPlaybackRoutes(t *testing.T) {
	setupUserTestDB(t)
	root := t.TempDir()
	withLocalMusicDownloadDir(t, root)
	const file = "深蓝泡沫 - Hotcell.flac"
	const mid = "0008mqT01SeqJC"
	// 截取旧 FLAC 中的一个原文行和紧随其后的译文行。
	const original = "[00:06.900]Call [00:07.140]my [00:07.200]name [00:07.440]I'm [00:07.500]fading [00:07.920]fading [00:08.160]fading"
	const translation = "[00:08.730]唤[00:08.910]我[00:08.970]姓[00:09.030]名"
	const custom = "[00:08.73]自定义注音"
	stored := strings.Join([]string{original, translation, custom}, "\n")
	if err := os.WriteFile(filepath.Join(root, file), []byte("fLaC"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "深蓝泡沫 - Hotcell.lrc"), []byte(stored), 0644); err != nil {
		t.Fatal(err)
	}
	if err := recordDownload(1, file, "qq", mid, "深蓝泡沫", "Hotcell"); err != nil {
		t.Fatal(err)
	}
	calls := 0
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID           string
			Translations bool `json:"inline_translations"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.ID != mid || !request.Translations {
			t.Errorf("unexpected provider request: %+v %v", request, err)
		}
		calls++
		_ = json.NewEncoder(w).Encode(map[string]string{"inline_translations": translation})
	}))
	defer sidecar.Close()
	t.Setenv("MUSIC_DL_PROVIDER_URL", sidecar.URL)
	router := musicRouterForUser(1, RoleUser)
	for _, tc := range []struct{ method, query, body string }{
		{"GET", "source=qq&id=" + mid, ""},
		{"GET", "source=local&id=" + encodeLocalMusicID(file), ""},
		{"POST", "source=qq&id=" + mid, stored},
	} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(tc.method, RoutePrefix+"/lyric?"+tc.query, strings.NewReader(tc.body)))
		if rec.Code != http.StatusOK || rec.Body.String() != original+"\n"+custom {
			t.Fatalf("%s %s: %d %q", tc.method, tc.query, rec.Code, rec.Body.String())
		}
	}
	if calls != 1 {
		t.Fatalf("expected one provider lookup across all playback routes, got %d", calls)
	}
}

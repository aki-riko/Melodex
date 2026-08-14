package core

import (
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

const neteaseIntegrationTrackID = "496869422"

func withNeteaseIntegrationCookie(t *testing.T) string {
	t.Helper()
	if os.Getenv("MELODEX_INTEGRATION") == "" {
		t.Skip("set MELODEX_INTEGRATION=1 to run provider network tests")
	}
	cookie := strings.TrimSpace(os.Getenv("NETEASE_COOKIE"))
	if cookie == "" {
		t.Skip("NETEASE_COOKIE not set")
	}
	previous := CM.GetAll()
	CM.mu.Lock()
	CM.cookies = map[string]string{"netease": cookie}
	CM.mu.Unlock()
	t.Cleanup(func() {
		CM.mu.Lock()
		CM.cookies = previous
		CM.mu.Unlock()
	})
	return cookie
}

func TestNeteaseLosslessDownloadIntegration(t *testing.T) {
	withNeteaseIntegrationCookie(t)
	result, err := DownloadSongData(&model.Track{ID: neteaseIntegrationTrackID, Source: "netease", Name: "Netease FLAC Regression", Artist: "Netease"}, false, false)
	if err != nil {
		t.Fatalf("download NetEase fixture: %v", err)
	}
	if result.Ext != "flac" || len(result.Data) < 4 || string(result.Data[:4]) != "fLaC" {
		t.Fatalf("downloaded fixture ext/type/size/prefix = %q/%q/%d/%q", result.Ext, result.ContentType, len(result.Data), result.Data[:min(4, len(result.Data))])
	}
}

func TestNeteaseRangeAndTimingIntegration(t *testing.T) {
	withNeteaseIntegrationCookie(t)
	provider := GetDownloadFunc("netease")
	if provider == nil {
		t.Fatal("NetEase download provider is not wired")
	}
	started := time.Now()
	mediaURL, err := provider(&model.Track{ID: neteaseIntegrationTrackID, Source: "netease"})
	if err != nil {
		t.Fatalf("resolve NetEase media URL: %v", err)
	}
	t.Logf("media URL resolution took %s", time.Since(started).Round(time.Millisecond))

	for _, header := range []string{"bytes=0-3", "bytes=0-1048575", "bytes=1048576-5242879"} {
		status, size, elapsed, err := measureProviderRange(mediaURL, "netease", header)
		if err != nil {
			t.Fatalf("range %q failed: %v", header, err)
		}
		if status != http.StatusPartialContent && status != http.StatusOK {
			t.Fatalf("range %q status = %d", header, status)
		}
		t.Logf("range=%s status=%d bytes=%d elapsed=%s", header, status, size, elapsed.Round(time.Millisecond))
	}
}

func measureProviderRange(mediaURL, source, rangeHeader string) (int, int, time.Duration, error) {
	request, err := BuildSourceRequest(http.MethodGet, mediaURL, source, rangeHeader)
	if err != nil {
		return 0, 0, 0, err
	}
	started := time.Now()
	response, err := (&http.Client{Timeout: 2 * time.Minute}).Do(request)
	if err != nil {
		return 0, 0, 0, err
	}
	defer response.Body.Close()
	data, readErr := io.ReadAll(response.Body)
	return response.StatusCode, len(data), time.Since(started), readErr
}

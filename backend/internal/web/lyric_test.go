package web

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestLyricEndpointReturnsReadableFallbackWhenLyricMissing(t *testing.T) {
	gin.SetMode(gin.TestMode)

	router := gin.New()
	RegisterMusicRoutes(router.Group(RoutePrefix))

	req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/lyric?id=test-id&source=missing", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	const want = "[00:00.00] 暂无歌词"
	if got := rec.Body.String(); got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}

func TestLyricEndpointWithRealQQSpringLetter(t *testing.T) {
	if os.Getenv("MUSIC_LIB_LIVE_QQ_LYRIC") != "1" {
		t.Skip("set MUSIC_LIB_LIVE_QQ_LYRIC=1 to run the live QQ lyric endpoint check")
	}
	gin.SetMode(gin.TestMode)

	router := gin.New()
	RegisterMusicRoutes(router.Group(RoutePrefix))
	params := url.Values{
		"id":       {"00498DKO1STwWZ"},
		"source":   {"qq"},
		"name":     {"春信迟"},
		"artist":   {"婴戏浅戈"},
		"album":    {"春信迟"},
		"duration": {"274"},
		"extra":    {`{"_rank":"0","has_lossless":"1","is_paid":"1","song_id":"585226910","songmid":"00498DKO1STwWZ"}`},
	}
	req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/lyric?"+params.Encode(), nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := rec.Header().Get("X-Lyric-Source"); got != "qq" {
		t.Fatalf("X-Lyric-Source = %q, want qq", got)
	}
	for _, want := range []string{"如初见 你从桥边折枝缓缓来", "迟来花信墨痕洇透谁的等待"} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Fatalf("live lyric missing %q: %.300s", want, rec.Body.String())
		}
	}
}

func TestLyricEndpointSharesSearchRateLimit(t *testing.T) {
	originalLimiter := searchRateLimiter
	searchRateLimiter = newRateLimiter(1, time.Minute)
	t.Cleanup(func() { searchRateLimiter = originalLimiter })
	gin.SetMode(gin.TestMode)

	router := gin.New()
	RegisterMusicRoutes(router.Group(RoutePrefix))
	requestURL := RoutePrefix + "/lyric?id=test-id&source=missing"

	first := httptest.NewRecorder()
	router.ServeHTTP(first, httptest.NewRequest(http.MethodGet, requestURL, nil))
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d, want %d", first.Code, http.StatusOK)
	}

	second := httptest.NewRecorder()
	router.ServeHTTP(second, httptest.NewRequest(http.MethodGet, requestURL, nil))
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("second status = %d, want %d", second.Code, http.StatusTooManyRequests)
	}
}

package web

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/gin-gonic/gin"
)

func TestLyricHTTPContract(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterMusicRoutes(router.Group(RoutePrefix))
	path := RoutePrefix + "/lyric?id=test-id&source=missing"
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	if recorder.Code != http.StatusOK || recorder.Body.String() != "[00:00.00] 暂无歌词" {
		t.Fatalf("missing lyric response = %d/%q", recorder.Code, recorder.Body.String())
	}

	previousLimiter := searchRateLimiter
	searchRateLimiter = newRateLimiter(1, time.Minute)
	t.Cleanup(func() { searchRateLimiter = previousLimiter })
	limitedRouter := gin.New()
	RegisterMusicRoutes(limitedRouter.Group(RoutePrefix))
	first := httptest.NewRecorder()
	limitedRouter.ServeHTTP(first, httptest.NewRequest(http.MethodGet, path, nil))
	second := httptest.NewRecorder()
	limitedRouter.ServeHTTP(second, httptest.NewRequest(http.MethodGet, path, nil))
	if first.Code != http.StatusOK || second.Code != http.StatusTooManyRequests {
		t.Fatalf("shared lyric rate limit = %d then %d", first.Code, second.Code)
	}
}

func TestLiveQQLyricIntegration(t *testing.T) {
	if os.Getenv("MELODEX_LIVE_QQ_LYRIC") != "1" {
		t.Skip("set MELODEX_LIVE_QQ_LYRIC=1 to run the live QQ lyric check")
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
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, RoutePrefix+"/lyric?"+params.Encode(), nil))
	if recorder.Code != http.StatusOK || recorder.Header().Get("X-Lyric-Source") != "qq" {
		t.Fatalf("live lyric status/source = %d/%q, body=%s", recorder.Code, recorder.Header().Get("X-Lyric-Source"), recorder.Body.String())
	}
	for _, line := range []string{"如初见 你从桥边折枝缓缓来", "迟来花信墨痕洇透谁的等待"} {
		if !strings.Contains(recorder.Body.String(), line) {
			t.Fatalf("live lyric missing %q: %.300s", line, recorder.Body.String())
		}
	}
}

func TestLyricFormattingContract(t *testing.T) {
	karaoke := "[00:01.00]你[00:01.50]好[00:02.00]\n[00:01.00]hello[00:02.00]\n[00:01.00]ni hao[00:02.00]"
	if got := classifyLyricFormat(karaoke); got != lyricFormatKaraoke {
		t.Fatalf("karaoke lyric format = %q", got)
	}
	if got := classifyLyricFormat("[00:01.00]你好\n[00:02.00]世界"); got != lyricFormatLine {
		t.Fatalf("line lyric format = %q", got)
	}
	original := lyricOriginalLineOnly("[ti:test]\n[00:01.00]你[00:01.50]好[00:02.00]\n[00:01.00]hello[00:02.00]\n[00:03.00]世界[00:04.00]")
	for _, line := range []string{"[ti:test]", "[00:01.00]你好", "[00:03.00]世界"} {
		if !strings.Contains(original, line) {
			t.Fatalf("original lyric missing %q: %s", line, original)
		}
	}
	if strings.Contains(original, "hello") || strings.Contains(original, "[00:01.50]") {
		t.Fatalf("original lyric retained translation or word timestamps: %s", original)
	}
}

func TestCoverProxySSRFContract(t *testing.T) {
	gin.SetMode(gin.TestMode)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte{0x89, 0x50, 0x4e, 0x47})
	}))
	defer upstream.Close()
	router := gin.New()
	RegisterMusicRoutes(router.Group(RoutePrefix))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, RoutePrefix+"/cover_proxy?url="+url.QueryEscape(upstream.URL), nil))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("loopback cover proxy status = %d", recorder.Code)
	}

	blocked := []string{"http://127.0.0.1/x", "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/", "http://10.0.0.1/", "file:///etc/passwd", "ftp://example.com/x", "http://[::1]/x"}
	for _, target := range blocked {
		if err := isPublicHTTPURL(target); err == nil {
			t.Fatalf("private or unsupported cover target accepted: %s", target)
		}
	}
	for _, target := range []string{"https://p1.music.126.net/cover.jpg", "http://y.gtimg.cn/music/photo.jpg"} {
		if err := isPublicHTTPURL(target); err != nil {
			t.Fatalf("public cover target rejected: %s (%v)", target, err)
		}
	}
}

func TestSearchSourceAndAlbumPriorityContract(t *testing.T) {
	if got := defaultSourcesForSearchType("album"); !reflect.DeepEqual(got, core.GetAlbumSourceNames()) {
		t.Fatalf("album search sources = %v", got)
	}
	if got := defaultSourcesForSearchType("playlist"); len(got) == 0 {
		t.Fatal("playlist search sources are empty")
	}
	if got := defaultSourcesForSearchType("song"); len(got) == 0 {
		t.Fatal("song search sources are empty")
	}
	if got := defaultSourcesForSearchType("lyric"); !reflect.DeepEqual(got, core.GetLyricSearchSourceNames()) {
		t.Fatalf("lyric search sources = %v", got)
	}

	withCredentials := []model.RemoteCollection{{ID: "kg-1", Source: "kugou"}, {ID: "kw-1", Source: "kuwo"}, {ID: "qq-1", Source: "qq"}, {ID: "qq-2", Source: "qq"}, {ID: "ne-1", Source: "netease"}}
	prioritizeAlbumsBySource(withCredentials, []string{"netease", "qq", "kugou", "kuwo"}, map[string]string{"qq": "saved credential"})
	if got := collectionIDs(withCredentials); !reflect.DeepEqual(got, []string{"qq-1", "qq-2", "ne-1", "kg-1", "kw-1"}) {
		t.Fatalf("credential-prioritized albums = %v", got)
	}
	withoutCredentials := []model.RemoteCollection{{ID: "kg-1", Source: "kugou"}, {ID: "qq-1", Source: "qq"}, {ID: "ne-1", Source: "netease"}, {ID: "qq-2", Source: "qq"}}
	prioritizeAlbumsBySource(withoutCredentials, []string{"netease", "qq", "kugou"}, nil)
	if got := collectionIDs(withoutCredentials); !reflect.DeepEqual(got, []string{"ne-1", "qq-1", "qq-2", "kg-1"}) {
		t.Fatalf("request-order albums = %v", got)
	}
}

func collectionIDs(collections []model.RemoteCollection) []string {
	ids := make([]string, 0, len(collections))
	for _, collection := range collections {
		ids = append(ids, collection.ID)
	}
	return ids
}

func TestDownloadContentDispositionContract(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	filename := "没地址的信 - 阮俊霖.mp3"
	setDownloadHeader(ctx, filename)
	header := recorder.Header().Get("Content-Disposition")
	if !strings.Contains(header, `filename="download.mp3"`) || !strings.Contains(header, "filename*=UTF-8''"+url.PathEscape(filename)) || strings.Contains(header, "%25E6") {
		t.Fatalf("Unicode content disposition = %q", header)
	}

	recorder = httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(recorder)
	setDownloadHeader(ctx, "阮俊霖/专辑/没地址的信 - 阮俊霖.flac")
	if header := recorder.Header().Get("Content-Disposition"); !strings.Contains(header, "filename*=UTF-8''"+url.PathEscape("没地址的信 - 阮俊霖.flac")) {
		t.Fatalf("path content disposition = %q", header)
	}

	for _, tc := range []struct{ input, want string }{
		{"没地址的信 - 阮俊霖.mp3", "download.mp3"},
		{"Song - Artist.flac", "Song - Artist.flac"},
		{" 测试 demo - 歌手.m4a ", "demo.m4a"},
		{"", "download"},
	} {
		if got := asciiDownloadFilenameFallback(tc.input); got != tc.want {
			t.Fatalf("ASCII fallback for %q = %q, want %q", tc.input, got, tc.want)
		}
	}
}

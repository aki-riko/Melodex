package web

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func newRecognitionTestRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/v1/recognize/status", func(c *gin.Context) {
		c.Set(ctxUserID, uint(1))
		jsonRecognitionStatusHandler(c)
	})
	r.POST("/api/v1/recognize", func(c *gin.Context) {
		c.Set(ctxUserID, uint(1))
		jsonRecognizeAudioHandler(c)
	})
	return r
}

func newRecognitionRequest(t *testing.T, body []byte) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("file", "clip.webm")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := part.Write(body); err != nil {
		t.Fatalf("write form file: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/recognize", &buf)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	return req
}

func clearRecognitionEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"MUSIC_DL_RECOGNITION_PROVIDER",
		"MUSIC_DL_RECOGNITION_MAX_BYTES",
		"MUSIC_DL_RECOGNITION_TIMEOUT",
		"MUSIC_DL_RECOGNITION_RATE_LIMIT_PER_MINUTE",
		"MUSIC_DL_AUDD_ENDPOINT",
		"MUSIC_DL_AUDD_TOKEN",
		"MUSIC_DL_AUDD_RETURN",
		"MUSIC_DL_ACRCLOUD_ENDPOINT",
		"MUSIC_DL_ACRCLOUD_ACCESS_KEY",
		"MUSIC_DL_ACRCLOUD_ACCESS_SECRET",
	} {
		t.Setenv(key, "")
	}
}

func TestRecognitionStatusDisabled(t *testing.T) {
	clearRecognitionEnv(t)
	r := newRecognitionTestRouter()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/recognize/status", nil)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var resp recognitionStatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Enabled {
		t.Fatalf("enabled = true, want false")
	}
	if resp.RateLimitPerMinute != defaultRecognitionRateLimitPerMinute {
		t.Fatalf("rate_limit_per_minute = %d, want %d", resp.RateLimitPerMinute, defaultRecognitionRateLimitPerMinute)
	}
	if resp.MaxBytes != recognitionDefaultMaxBytes || resp.Timeout != recognitionDefaultTimeout.String() {
		t.Fatalf("limits = max_bytes:%d timeout:%q, want defaults", resp.MaxBytes, resp.Timeout)
	}
}

func TestRecognitionStatusReportsConfiguredLimitsWithoutSecrets(t *testing.T) {
	clearRecognitionEnv(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("status endpoint must not call provider")
	}))
	defer provider.Close()

	t.Setenv("MUSIC_DL_RECOGNITION_PROVIDER", "audd")
	t.Setenv("MUSIC_DL_AUDD_ENDPOINT", provider.URL)
	t.Setenv("MUSIC_DL_AUDD_TOKEN", "unit-token")
	t.Setenv("MUSIC_DL_RECOGNITION_MAX_BYTES", "12345")
	t.Setenv("MUSIC_DL_RECOGNITION_TIMEOUT", "7s")
	t.Setenv(recognitionRateLimitEnv, "3")

	r := newRecognitionTestRouter()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/recognize/status", nil)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var resp recognitionStatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !resp.Enabled || resp.Provider != recognitionProviderAudD {
		t.Fatalf("status response = %+v, want enabled audd", resp)
	}
	if resp.MaxBytes != 12345 || resp.Timeout != "7s" || resp.RateLimitPerMinute != 3 {
		t.Fatalf("limits = max_bytes:%d timeout:%q rate:%d, want 12345/7s/3", resp.MaxBytes, resp.Timeout, resp.RateLimitPerMinute)
	}
	if body := rec.Body.String(); strings.Contains(body, "unit-token") || strings.Contains(body, provider.URL) {
		t.Fatalf("status response leaked provider secret or endpoint: %s", body)
	}
}

func TestRecognitionStatusRejectsExternalHTTPProviderEndpoint(t *testing.T) {
	clearRecognitionEnv(t)
	t.Setenv("MUSIC_DL_RECOGNITION_PROVIDER", "audd")
	t.Setenv("MUSIC_DL_AUDD_ENDPOINT", "http://example.com/")
	t.Setenv("MUSIC_DL_AUDD_TOKEN", "unit-token")
	r := newRecognitionTestRouter()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/recognize/status", nil)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var resp recognitionStatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Enabled {
		t.Fatalf("enabled = true, want false")
	}
	if !strings.Contains(resp.Error, "只能指向本机测试地址") {
		t.Fatalf("error = %q, want loopback endpoint message", resp.Error)
	}
}

func TestRecognizeAudioRequiresSameOriginXHR(t *testing.T) {
	clearRecognitionEnv(t)
	r := newRecognitionTestRouter()
	req := newRecognitionRequest(t, []byte("fake audio bytes"))
	req.Header.Del("X-Requested-With")

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusForbidden, rec.Body.String())
	}
}

func TestRecognizeAudioDisabledWithoutProvider(t *testing.T) {
	clearRecognitionEnv(t)
	r := newRecognitionTestRouter()
	req := newRecognitionRequest(t, []byte("fake audio bytes"))

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusServiceUnavailable, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "听歌识曲未启用") {
		t.Fatalf("body = %s, want disabled message", rec.Body.String())
	}
}

func TestRecognizeAudioRouteIsRateLimited(t *testing.T) {
	clearRecognitionEnv(t)
	setupUserTestDB(t)
	resetAuthRuntimeForTest()
	t.Cleanup(resetAuthRuntimeForTest)
	user, err := createUser("alice", "alicepass1", RoleUser)
	if err != nil {
		t.Fatalf("createUser: %v", err)
	}
	cookie := mustSession(t, user)

	oldLimiter := recognitionRateLimiter
	recognitionRateLimiter = newRateLimiter(2, time.Minute)
	t.Cleanup(func() { recognitionRateLimiter = oldLimiter })

	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterJSONAPIRoutes(r, StartOptions{})

	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/recognize", nil)
		req.Header.Set("X-Requested-With", "XMLHttpRequest")
		req.Header.Set("Accept", "application/json")
		req.AddCookie(cookie)
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("request %d status = %d, want %d, body=%s", i+1, rec.Code, http.StatusServiceUnavailable, rec.Body.String())
		}
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/recognize", nil)
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	req.Header.Set("Accept", "application/json")
	req.AddCookie(cookie)
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("third request status = %d, want %d, body=%s", rec.Code, http.StatusTooManyRequests, rec.Body.String())
	}
}

func TestRecognizeAudioAudDSuccess(t *testing.T) {
	clearRecognitionEnv(t)
	var sawToken bool
	var sawFile bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("provider method = %s, want POST", r.Method)
		}
		if err := r.ParseMultipartForm(2 << 20); err != nil {
			t.Fatalf("parse multipart: %v", err)
		}
		sawToken = r.FormValue("api_token") == "unit-token"
		file, _, err := r.FormFile("file")
		if err != nil {
			t.Fatalf("provider missing file: %v", err)
		}
		defer file.Close()
		data, err := io.ReadAll(file)
		if err != nil {
			t.Fatalf("read provider file: %v", err)
		}
		sawFile = string(data) == "fake audio bytes"
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"status":"success",
			"result":{
				"artist":"Tears For Fears",
				"title":"Everybody Wants To Rule The World",
				"album":"Songs From The Big Chair",
				"release_date":"1985-02-25",
				"timecode":"00:56",
				"song_link":"https://lis.tn/example",
				"spotify":{"external_ids":{"isrc":"GBUM71403885"}}
			}
		}`))
	}))
	defer provider.Close()

	t.Setenv("MUSIC_DL_RECOGNITION_PROVIDER", "audd")
	t.Setenv("MUSIC_DL_AUDD_ENDPOINT", provider.URL)
	t.Setenv("MUSIC_DL_AUDD_TOKEN", "unit-token")

	r := newRecognitionTestRouter()
	req := newRecognitionRequest(t, []byte("fake audio bytes"))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !sawToken || !sawFile {
		t.Fatalf("provider saw token=%v file=%v, want both true", sawToken, sawFile)
	}
	var resp recognitionAPIResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !resp.Matched {
		t.Fatalf("matched = false, body=%s", rec.Body.String())
	}
	if resp.Query != "Everybody Wants To Rule The World Tears For Fears" {
		t.Fatalf("query = %q", resp.Query)
	}
	if resp.Result == nil || resp.Result.ISRC != "GBUM71403885" {
		t.Fatalf("result = %+v, want ISRC", resp.Result)
	}
}

func TestRecognizeAudioACRCloudSuccess(t *testing.T) {
	clearRecognitionEnv(t)
	var sawAccessKey bool
	var sawSample bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/identify" {
			t.Fatalf("provider path = %s, want /v1/identify", r.URL.Path)
		}
		if err := r.ParseMultipartForm(2 << 20); err != nil {
			t.Fatalf("parse multipart: %v", err)
		}
		sawAccessKey = r.FormValue("access_key") == "unit-key" &&
			r.FormValue("data_type") == "audio" &&
			r.FormValue("signature_version") == "1" &&
			r.FormValue("sample_bytes") == "16" &&
			r.FormValue("signature") != "" &&
			r.FormValue("timestamp") != ""
		file, _, err := r.FormFile("sample")
		if err != nil {
			t.Fatalf("provider missing sample: %v", err)
		}
		defer file.Close()
		data, err := io.ReadAll(file)
		if err != nil {
			t.Fatalf("read provider sample: %v", err)
		}
		sawSample = string(data) == "fake audio bytes"
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"status":{"code":0,"msg":"Success"},
			"metadata":{"music":[{
				"title":"晴天",
				"score":95,
				"release_date":"2003-07-31",
				"play_offset_ms":65000,
				"artists":[{"name":"周杰伦"}],
				"album":{"name":"叶惠美"},
				"external_ids":{"isrc":"TWA450386102"}
			}]}
		}`))
	}))
	defer provider.Close()

	t.Setenv("MUSIC_DL_RECOGNITION_PROVIDER", "acrcloud")
	t.Setenv("MUSIC_DL_ACRCLOUD_ENDPOINT", provider.URL+"/v1/identify")
	t.Setenv("MUSIC_DL_ACRCLOUD_ACCESS_KEY", "unit-key")
	t.Setenv("MUSIC_DL_ACRCLOUD_ACCESS_SECRET", "unit-secret")

	r := newRecognitionTestRouter()
	req := newRecognitionRequest(t, []byte("fake audio bytes"))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !sawAccessKey || !sawSample {
		t.Fatalf("provider saw fields=%v sample=%v, want both true", sawAccessKey, sawSample)
	}
	var resp recognitionAPIResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Query != "晴天 周杰伦" {
		t.Fatalf("query = %q", resp.Query)
	}
	if resp.Result == nil || resp.Result.Score != 95 || resp.Result.Timecode != "01:05" {
		t.Fatalf("result = %+v, want score/timecode", resp.Result)
	}
}

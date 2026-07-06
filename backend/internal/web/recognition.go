package web

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	recognitionProviderAudD     = "audd"
	recognitionProviderACRCloud = "acrcloud"

	recognitionDefaultMaxBytes        int64 = 10 * 1024 * 1024
	recognitionMultipartOverheadBytes       = 1 * 1024 * 1024
	recognitionDefaultTimeout               = 20 * time.Second
	recognitionMaxResponseBytes       int64 = 2 * 1024 * 1024
)

type recognitionConfig struct {
	Provider        string
	MaxBytes        int64
	Timeout         time.Duration
	AudDEndpoint    string
	AudDToken       string
	AudDReturn      string
	ACREndpoint     string
	ACRAccessKey    string
	ACRAccessSecret string
}

type recognitionAudioInput struct {
	Filename    string
	ContentType string
	Data        []byte
}

type musicRecognitionResult struct {
	Title       string `json:"title,omitempty"`
	Artist      string `json:"artist,omitempty"`
	Album       string `json:"album,omitempty"`
	ReleaseDate string `json:"release_date,omitempty"`
	Label       string `json:"label,omitempty"`
	Timecode    string `json:"timecode,omitempty"`
	SongLink    string `json:"song_link,omitempty"`
	ISRC        string `json:"isrc,omitempty"`
	Score       int    `json:"score,omitempty"`
}

type recognitionAPIResponse struct {
	Status   string                  `json:"status"`
	Matched  bool                    `json:"matched"`
	Provider string                  `json:"provider,omitempty"`
	Query    string                  `json:"query,omitempty"`
	Result   *musicRecognitionResult `json:"result,omitempty"`
	Error    string                  `json:"error,omitempty"`
}

type recognitionStatusResponse struct {
	Enabled  bool   `json:"enabled"`
	Provider string `json:"provider,omitempty"`
	MaxBytes int64  `json:"max_bytes,omitempty"`
	Timeout  string `json:"timeout,omitempty"`
	Error    string `json:"error,omitempty"`
}

type recognitionStatusError struct {
	Status  int
	Message string
}

func (e *recognitionStatusError) Error() string {
	return e.Message
}

func loadRecognitionConfig() recognitionConfig {
	cfg := recognitionConfig{
		Provider:        strings.ToLower(strings.TrimSpace(os.Getenv("MUSIC_DL_RECOGNITION_PROVIDER"))),
		MaxBytes:        envInt64("MUSIC_DL_RECOGNITION_MAX_BYTES", recognitionDefaultMaxBytes),
		Timeout:         envDuration("MUSIC_DL_RECOGNITION_TIMEOUT", recognitionDefaultTimeout),
		AudDEndpoint:    strings.TrimSpace(os.Getenv("MUSIC_DL_AUDD_ENDPOINT")),
		AudDToken:       strings.TrimSpace(os.Getenv("MUSIC_DL_AUDD_TOKEN")),
		AudDReturn:      strings.TrimSpace(os.Getenv("MUSIC_DL_AUDD_RETURN")),
		ACREndpoint:     strings.TrimSpace(os.Getenv("MUSIC_DL_ACRCLOUD_ENDPOINT")),
		ACRAccessKey:    strings.TrimSpace(os.Getenv("MUSIC_DL_ACRCLOUD_ACCESS_KEY")),
		ACRAccessSecret: strings.TrimSpace(os.Getenv("MUSIC_DL_ACRCLOUD_ACCESS_SECRET")),
	}
	if cfg.MaxBytes <= 0 {
		cfg.MaxBytes = recognitionDefaultMaxBytes
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = recognitionDefaultTimeout
	}
	if cfg.Provider == "" {
		switch {
		case cfg.AudDEndpoint != "" && cfg.AudDToken != "":
			cfg.Provider = recognitionProviderAudD
		case cfg.ACREndpoint != "" && cfg.ACRAccessKey != "" && cfg.ACRAccessSecret != "":
			cfg.Provider = recognitionProviderACRCloud
		}
	}
	return cfg
}

func envInt64(key string, fallback int64) int64 {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func envDuration(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	if d, err := time.ParseDuration(raw); err == nil && d > 0 {
		return d
	}
	if seconds, err := strconv.Atoi(raw); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	return fallback
}

func (cfg recognitionConfig) validate() error {
	switch cfg.Provider {
	case "":
		return &recognitionStatusError{
			Status:  http.StatusServiceUnavailable,
			Message: "听歌识曲未启用: 请配置 MUSIC_DL_RECOGNITION_PROVIDER 以及对应服务的 endpoint/token",
		}
	case recognitionProviderAudD:
		if cfg.AudDEndpoint == "" || cfg.AudDToken == "" {
			return &recognitionStatusError{
				Status:  http.StatusServiceUnavailable,
				Message: "AudD 未配置完整: 需要 MUSIC_DL_AUDD_ENDPOINT 和 MUSIC_DL_AUDD_TOKEN",
			}
		}
		if err := validateRecognitionEndpoint(cfg.AudDEndpoint); err != nil {
			return &recognitionStatusError{Status: http.StatusServiceUnavailable, Message: err.Error()}
		}
	case recognitionProviderACRCloud:
		if cfg.ACREndpoint == "" || cfg.ACRAccessKey == "" || cfg.ACRAccessSecret == "" {
			return &recognitionStatusError{
				Status:  http.StatusServiceUnavailable,
				Message: "ACRCloud 未配置完整: 需要 MUSIC_DL_ACRCLOUD_ENDPOINT、MUSIC_DL_ACRCLOUD_ACCESS_KEY、MUSIC_DL_ACRCLOUD_ACCESS_SECRET",
			}
		}
		if err := validateRecognitionEndpoint(cfg.ACREndpoint); err != nil {
			return &recognitionStatusError{Status: http.StatusServiceUnavailable, Message: err.Error()}
		}
	default:
		return &recognitionStatusError{
			Status:  http.StatusServiceUnavailable,
			Message: "不支持的听歌识曲服务: " + cfg.Provider,
		}
	}
	return nil
}

func jsonRecognitionStatusHandler(c *gin.Context) {
	cfg := loadRecognitionConfig()
	if err := cfg.validate(); err != nil {
		c.JSON(http.StatusOK, recognitionStatusResponse{
			Enabled: false,
			Error:   err.Error(),
		})
		return
	}
	c.JSON(http.StatusOK, recognitionStatusResponse{
		Enabled:  true,
		Provider: cfg.Provider,
		MaxBytes: cfg.MaxBytes,
		Timeout:  cfg.Timeout.String(),
	})
}

func jsonRecognizeAudioHandler(c *gin.Context) {
	if !allowSameOriginWrite(c) {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return
	}
	if !requireUserForWrite(c) {
		return
	}

	cfg := loadRecognitionConfig()
	if err := cfg.validate(); err != nil {
		respondRecognitionError(c, err)
		return
	}

	limitRequestBody(c, cfg.MaxBytes+recognitionMultipartOverheadBytes)
	fileHeader, err := c.FormFile("file")
	if err != nil {
		status := http.StatusBadRequest
		msg := "请选择一段录音"
		if isRequestBodyTooLarge(err) {
			status = http.StatusRequestEntityTooLarge
			msg = fmt.Sprintf("录音过大,单次上限 %d MB", cfg.MaxBytes/1024/1024)
		}
		c.JSON(status, gin.H{"error": msg})
		return
	}
	if fileHeader.Size <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "录音为空,请重新识别"})
		return
	}
	if fileHeader.Size > cfg.MaxBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": fmt.Sprintf("录音过大,单次上限 %d MB", cfg.MaxBytes/1024/1024)})
		return
	}

	file, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "读取录音失败"})
		return
	}
	defer file.Close()

	data, err := readLimitedBody(file, cfg.MaxBytes)
	if err != nil {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": fmt.Sprintf("录音过大,单次上限 %d MB", cfg.MaxBytes/1024/1024)})
		return
	}

	result, err := recognizeAudioBytes(c.Request.Context(), cfg, recognitionAudioInput{
		Filename:    fileHeader.Filename,
		ContentType: fileHeader.Header.Get("Content-Type"),
		Data:        data,
	})
	if err != nil {
		respondRecognitionError(c, err)
		return
	}
	if result == nil || strings.TrimSpace(result.Title+result.Artist) == "" {
		c.JSON(http.StatusOK, recognitionAPIResponse{
			Status:   "success",
			Matched:  false,
			Provider: cfg.Provider,
			Error:    "没有识别到歌曲,可以靠近音源再录一次",
		})
		return
	}

	query := recognitionSearchQuery(result)
	c.JSON(http.StatusOK, recognitionAPIResponse{
		Status:   "success",
		Matched:  true,
		Provider: cfg.Provider,
		Query:    query,
		Result:   result,
	})
}

func respondRecognitionError(c *gin.Context, err error) {
	status := http.StatusBadGateway
	msg := err.Error()
	var statusErr *recognitionStatusError
	if errors.As(err, &statusErr) {
		status = statusErr.Status
		msg = statusErr.Message
	}
	c.JSON(status, gin.H{"error": msg})
}

func recognizeAudioBytes(ctx context.Context, cfg recognitionConfig, input recognitionAudioInput) (*musicRecognitionResult, error) {
	switch cfg.Provider {
	case recognitionProviderAudD:
		return recognizeWithAudD(ctx, cfg, input)
	case recognitionProviderACRCloud:
		return recognizeWithACRCloud(ctx, cfg, input)
	default:
		return nil, (&recognitionStatusError{Status: http.StatusServiceUnavailable, Message: "听歌识曲未启用"})
	}
}

func recognitionHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Transport: outboundStreamingHTTPClient.Transport,
		Timeout:   timeout,
	}
}

func validateRecognitionEndpoint(endpoint string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("识曲服务 endpoint 无效")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return fmt.Errorf("识曲服务 endpoint 只支持 http/https")
	}
	if u.Scheme == "http" && !isLoopbackEndpointHost(u.Hostname()) {
		return fmt.Errorf("识曲服务 endpoint 使用 http 时只能指向本机测试地址")
	}
	return nil
}

func isLoopbackEndpointHost(host string) bool {
	host = strings.TrimSpace(strings.ToLower(host))
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func safeRecognitionFilename(filename string) string {
	filename = strings.TrimSpace(strings.ReplaceAll(filename, "\\", "/"))
	if slash := strings.LastIndex(filename, "/"); slash >= 0 {
		filename = filename[slash+1:]
	}
	if filename == "" {
		return "recognition.webm"
	}
	return filename
}

func writeAudioMultipart(w *multipart.Writer, fieldName string, input recognitionAudioInput) error {
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, escapeQuotes(fieldName), escapeQuotes(safeRecognitionFilename(input.Filename))))
	if strings.TrimSpace(input.ContentType) != "" {
		header.Set("Content-Type", strings.TrimSpace(input.ContentType))
	}
	part, err := w.CreatePart(header)
	if err != nil {
		return err
	}
	_, err = part.Write(input.Data)
	return err
}

func escapeQuotes(value string) string {
	return strings.NewReplacer("\\", "\\\\", `"`, "\\\"").Replace(value)
}

func recognitionSearchQuery(result *musicRecognitionResult) string {
	if result == nil {
		return ""
	}
	parts := []string{}
	if title := strings.TrimSpace(result.Title); title != "" {
		parts = append(parts, title)
	}
	if artist := strings.TrimSpace(result.Artist); artist != "" {
		parts = append(parts, artist)
	}
	return strings.Join(parts, " ")
}

type auddRecognitionResponse struct {
	Status string `json:"status"`
	Result *struct {
		Artist      string                 `json:"artist"`
		Title       string                 `json:"title"`
		Album       string                 `json:"album"`
		ReleaseDate string                 `json:"release_date"`
		Label       string                 `json:"label"`
		Timecode    string                 `json:"timecode"`
		SongLink    string                 `json:"song_link"`
		AppleMusic  map[string]interface{} `json:"apple_music"`
		Spotify     map[string]interface{} `json:"spotify"`
	} `json:"result"`
	Error *struct {
		Code    int    `json:"error_code"`
		Message string `json:"error_message"`
	} `json:"error"`
}

func recognizeWithAudD(ctx context.Context, cfg recognitionConfig, input recognitionAudioInput) (*musicRecognitionResult, error) {
	if err := validateRecognitionEndpoint(cfg.AudDEndpoint); err != nil {
		return nil, &recognitionStatusError{Status: http.StatusServiceUnavailable, Message: err.Error()}
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("api_token", cfg.AudDToken); err != nil {
		return nil, err
	}
	if cfg.AudDReturn != "" {
		if err := writer.WriteField("return", cfg.AudDReturn); err != nil {
			return nil, err
		}
	}
	if err := writeAudioMultipart(writer, "file", input); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.AudDEndpoint, &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := recognitionHTTPClient(cfg.Timeout).Do(req)
	if err != nil {
		return nil, &recognitionStatusError{Status: http.StatusBadGateway, Message: "识曲服务请求失败: " + err.Error()}
	}
	defer resp.Body.Close()

	data, err := readLimitedBody(resp.Body, recognitionMaxResponseBytes)
	if err != nil {
		return nil, &recognitionStatusError{Status: http.StatusBadGateway, Message: "识曲服务响应过大"}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &recognitionStatusError{Status: http.StatusBadGateway, Message: fmt.Sprintf("识曲服务返回 HTTP %d", resp.StatusCode)}
	}

	var parsed auddRecognitionResponse
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, &recognitionStatusError{Status: http.StatusBadGateway, Message: "识曲服务响应解析失败"}
	}
	if parsed.Status == "error" {
		msg := "识曲失败"
		if parsed.Error != nil && strings.TrimSpace(parsed.Error.Message) != "" {
			msg = parsed.Error.Message
		}
		return nil, &recognitionStatusError{Status: http.StatusBadGateway, Message: msg}
	}
	if parsed.Result == nil {
		return nil, nil
	}

	isrc := stringFromNestedMap(parsed.Result.Spotify, "external_ids", "isrc")
	if isrc == "" {
		isrc = stringFromMap(parsed.Result.AppleMusic, "isrc")
	}
	return &musicRecognitionResult{
		Title:       strings.TrimSpace(parsed.Result.Title),
		Artist:      strings.TrimSpace(parsed.Result.Artist),
		Album:       strings.TrimSpace(parsed.Result.Album),
		ReleaseDate: strings.TrimSpace(parsed.Result.ReleaseDate),
		Label:       strings.TrimSpace(parsed.Result.Label),
		Timecode:    strings.TrimSpace(parsed.Result.Timecode),
		SongLink:    strings.TrimSpace(parsed.Result.SongLink),
		ISRC:        strings.TrimSpace(isrc),
	}, nil
}

type acrCloudRecognitionResponse struct {
	Status struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	} `json:"status"`
	Metadata struct {
		Music []struct {
			Title       string `json:"title"`
			Score       int    `json:"score"`
			ReleaseDate string `json:"release_date"`
			PlayOffset  int    `json:"play_offset_ms"`
			Artists     []struct {
				Name string `json:"name"`
			} `json:"artists"`
			Album struct {
				Name string `json:"name"`
			} `json:"album"`
			ExternalIDs struct {
				ISRC string `json:"isrc"`
			} `json:"external_ids"`
		} `json:"music"`
	} `json:"metadata"`
}

func recognizeWithACRCloud(ctx context.Context, cfg recognitionConfig, input recognitionAudioInput) (*musicRecognitionResult, error) {
	if err := validateRecognitionEndpoint(cfg.ACREndpoint); err != nil {
		return nil, &recognitionStatusError{Status: http.StatusServiceUnavailable, Message: err.Error()}
	}

	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	signatureURI := acrCloudSignatureURI(cfg.ACREndpoint)
	stringToSign := strings.Join([]string{
		http.MethodPost,
		signatureURI,
		cfg.ACRAccessKey,
		"audio",
		"1",
		timestamp,
	}, "\n")
	mac := hmac.New(sha1.New, []byte(cfg.ACRAccessSecret))
	_, _ = mac.Write([]byte(stringToSign))
	signature := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	fields := map[string]string{
		"access_key":        cfg.ACRAccessKey,
		"data_type":         "audio",
		"signature_version": "1",
		"signature":         signature,
		"sample_bytes":      strconv.Itoa(len(input.Data)),
		"timestamp":         timestamp,
	}
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			return nil, err
		}
	}
	if err := writeAudioMultipart(writer, "sample", input); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.ACREndpoint, &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := recognitionHTTPClient(cfg.Timeout).Do(req)
	if err != nil {
		return nil, &recognitionStatusError{Status: http.StatusBadGateway, Message: "识曲服务请求失败: " + err.Error()}
	}
	defer resp.Body.Close()

	data, err := readLimitedBody(resp.Body, recognitionMaxResponseBytes)
	if err != nil {
		return nil, &recognitionStatusError{Status: http.StatusBadGateway, Message: "识曲服务响应过大"}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &recognitionStatusError{Status: http.StatusBadGateway, Message: fmt.Sprintf("识曲服务返回 HTTP %d", resp.StatusCode)}
	}

	var parsed acrCloudRecognitionResponse
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, &recognitionStatusError{Status: http.StatusBadGateway, Message: "识曲服务响应解析失败"}
	}
	if parsed.Status.Code == 1001 {
		return nil, nil
	}
	if parsed.Status.Code != 0 {
		msg := strings.TrimSpace(parsed.Status.Msg)
		if msg == "" {
			msg = "识曲失败"
		}
		return nil, &recognitionStatusError{Status: http.StatusBadGateway, Message: msg}
	}
	if len(parsed.Metadata.Music) == 0 {
		return nil, nil
	}

	top := parsed.Metadata.Music[0]
	artistNames := []string{}
	for _, artist := range top.Artists {
		if name := strings.TrimSpace(artist.Name); name != "" {
			artistNames = append(artistNames, name)
		}
	}
	return &musicRecognitionResult{
		Title:       strings.TrimSpace(top.Title),
		Artist:      strings.Join(artistNames, " / "),
		Album:       strings.TrimSpace(top.Album.Name),
		ReleaseDate: strings.TrimSpace(top.ReleaseDate),
		Timecode:    formatRecognitionOffset(top.PlayOffset),
		ISRC:        strings.TrimSpace(top.ExternalIDs.ISRC),
		Score:       top.Score,
	}, nil
}

func acrCloudSignatureURI(endpoint string) string {
	u, err := url.Parse(endpoint)
	if err != nil || strings.TrimSpace(u.Path) == "" {
		return "/v1/identify"
	}
	return u.Path
}

func formatRecognitionOffset(ms int) string {
	if ms <= 0 {
		return ""
	}
	totalSeconds := ms / 1000
	return fmt.Sprintf("%02d:%02d", totalSeconds/60, totalSeconds%60)
}

func stringFromMap(m map[string]interface{}, key string) string {
	if m == nil {
		return ""
	}
	value, ok := m[key]
	if !ok {
		return ""
	}
	if s, ok := value.(string); ok {
		return s
	}
	return ""
}

func stringFromNestedMap(m map[string]interface{}, first, second string) string {
	if m == nil {
		return ""
	}
	value, ok := m[first]
	if !ok {
		return ""
	}
	nested, ok := value.(map[string]interface{})
	if !ok {
		return ""
	}
	return stringFromMap(nested, second)
}

package qq

import (
	"bytes"
	"context"
	"crypto/sha1"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/guohuiyuan/music-lib/utils"
)

//go:embed qq_security_helper.js
var qqSecurityHelperJS []byte

var (
	qqSecurityHelperPathOnce sync.Once
	qqSecurityHelperPath     string
	qqSecurityHelperPathErr  error
)

var qqMusicuPost = func(jsonData []byte, headers ...utils.RequestOption) ([]byte, error) {
	if body, err := qqSecurityPost(jsonData, headers...); err == nil {
		return body, nil
	}
	return utils.Post("https://u.y.qq.com/cgi-bin/musicu.fcg", bytes.NewReader(jsonData), headers...)
}

var qqVIPPost = func(apiURL string, body io.Reader, headers ...utils.RequestOption) ([]byte, error) {
	jsonData, err := io.ReadAll(body)
	if err != nil {
		return nil, err
	}
	if strings.Contains(apiURL, "/cgi-bin/musicu.fcg") {
		if secureBody, err := qqSecurityPost(jsonData, headers...); err == nil {
			return secureBody, nil
		}
	}
	return utils.Post(apiURL, bytes.NewReader(jsonData), headers...)
}

type qqSecurityHelperInput struct {
	Body      string            `json:"body"`
	Headers   map[string]string `json:"headers,omitempty"`
	CacheDir  string            `json:"cacheDir,omitempty"`
	TimeoutMS int               `json:"timeoutMs,omitempty"`
}

type qqSecurityHelperOutput struct {
	OK     bool   `json:"ok"`
	Status int    `json:"status,omitempty"`
	Body   string `json:"body,omitempty"`
	Error  string `json:"error,omitempty"`
}

func qqSecurityPost(jsonData []byte, headers ...utils.RequestOption) ([]byte, error) {
	if len(jsonData) == 0 {
		return nil, errors.New("empty qq security request")
	}
	if qqSecurityDisabled() {
		return nil, errors.New("qq security helper disabled")
	}

	nodePath, err := qqSecurityNodePath()
	if err != nil {
		return nil, err
	}
	helperPath, err := ensureQQSecurityHelperPath()
	if err != nil {
		return nil, err
	}

	payload, err := json.Marshal(qqSecurityHelperInput{
		Body:      string(jsonData),
		Headers:   qqHeadersFromOptions(headers...),
		CacheDir:  qqSecurityCacheDir(),
		TimeoutMS: 20000,
	})
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, nodePath, helperPath)
	cmd.Stdin = bytes.NewReader(payload)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	var result qqSecurityHelperOutput
	parseErr := json.Unmarshal(stdout.Bytes(), &result)
	if parseErr != nil {
		if runErr != nil {
			return nil, fmt.Errorf("qq security helper failed: %v: %s", runErr, qqSecurityErrorText(stderr.String()))
		}
		return nil, fmt.Errorf("qq security helper output parse error: %w", parseErr)
	}
	if runErr != nil || !result.OK {
		msg := result.Error
		if msg == "" {
			msg = stderr.String()
		}
		if msg == "" && runErr != nil {
			msg = runErr.Error()
		}
		return nil, fmt.Errorf("qq security helper failed: %s", qqSecurityErrorText(msg))
	}
	if strings.TrimSpace(result.Body) == "" {
		return nil, errors.New("qq security helper returned empty body")
	}
	return []byte(result.Body), nil
}

func qqSecurityDisabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("MUSIC_DL_QQ_SECURITY_DISABLED"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func qqSecurityNodePath() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("MUSIC_DL_QQ_SECURITY_NODE")); configured != "" {
		if strings.ContainsAny(configured, `/\`) {
			if _, err := os.Stat(configured); err != nil {
				return "", err
			}
			return configured, nil
		}
		return exec.LookPath(configured)
	}
	return exec.LookPath("node")
}

func ensureQQSecurityHelperPath() (string, error) {
	qqSecurityHelperPathOnce.Do(func() {
		sum := sha1.Sum(qqSecurityHelperJS)
		name := "qq_security_helper_" + hex.EncodeToString(sum[:8]) + ".js"
		dir := strings.TrimSpace(os.Getenv("MUSIC_DL_QQ_SECURITY_HELPER_DIR"))
		if dir == "" {
			dir = filepath.Join(os.TempDir(), "melodex-qq-security-helper")
		}
		if err := os.MkdirAll(dir, 0700); err != nil {
			qqSecurityHelperPathErr = err
			return
		}
		path := filepath.Join(dir, name)
		if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, qqSecurityHelperJS) {
			qqSecurityHelperPath = path
			return
		}
		if err := os.WriteFile(path, qqSecurityHelperJS, 0600); err != nil {
			qqSecurityHelperPathErr = err
			return
		}
		qqSecurityHelperPath = path
	})
	return qqSecurityHelperPath, qqSecurityHelperPathErr
}

func qqSecurityCacheDir() string {
	if dir := strings.TrimSpace(os.Getenv("MUSIC_DL_QQ_SECURITY_CACHE_DIR")); dir != "" {
		return dir
	}
	return filepath.Join(os.TempDir(), "melodex-qq-security-cache")
}

func qqHeadersFromOptions(options ...utils.RequestOption) map[string]string {
	req, err := http.NewRequest(http.MethodPost, "https://u.y.qq.com/cgi-bin/musicu.fcg", nil)
	if err != nil {
		return nil
	}
	for _, option := range options {
		if option != nil {
			option(req)
		}
	}
	headers := make(map[string]string, len(req.Header))
	for key, values := range req.Header {
		if len(values) > 0 {
			headers[key] = strings.Join(values, ", ")
		}
	}
	return headers
}

func qqSecurityErrorText(value string) string {
	value = strings.TrimSpace(value)
	value = strings.ReplaceAll(value, "\r", " ")
	value = strings.ReplaceAll(value, "\n", " ")
	if len(value) > 500 {
		value = value[:500] + "..."
	}
	if value == "" {
		return "unknown error"
	}
	return value
}

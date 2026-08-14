package extensions

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/guohuiyuan/go-music-dl/internal/provider/model"
)

func NeteaseCreateQRLogin() (*model.QRLoginSession, error) {
	payload, _, err := neteaseQRRequest("/api/login/qrcode/unikey", url.Values{"type": {"1"}})
	if err != nil {
		return nil, err
	}
	key := text(at(payload, "unikey"))
	if key == "" {
		key = text(at(payload, "data", "unikey"))
	}
	if key == "" {
		return nil, fmt.Errorf("netease QR endpoint returned no key")
	}
	return &model.QRLoginSession{
		Source: "netease", Key: key,
		URL: "https://music.163.com/login?codekey=" + url.QueryEscape(key),
	}, nil
}

func NeteaseCheckQRLogin(key string) (*model.QRLoginResult, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return nil, fmt.Errorf("netease QR key is required")
	}
	payload, cookies, err := neteaseQRRequest("/api/login/qrcode/client/login", url.Values{"key": {key}, "type": {"1"}})
	if err != nil {
		return nil, err
	}
	code := integer(payload["code"])
	result := &model.QRLoginResult{Source: "netease", Key: key, Message: text(payload["message"]), Cookies: cookies}
	switch code {
	case 800:
		result.Status = model.QRLoginStatusExpired
	case 801:
		result.Status = model.QRLoginStatusWaiting
	case 802:
		result.Status = model.QRLoginStatusScanned
	case 803:
		result.Status = model.QRLoginStatusSuccess
	default:
		result.Status = model.QRLoginStatusFailed
	}
	if cookie := text(payload["cookie"]); cookie != "" {
		result.Cookie = cookie
	} else if len(cookies) > 0 {
		parts := make([]string, 0, len(cookies))
		for name, value := range cookies {
			parts = append(parts, name+"="+value)
		}
		result.Cookie = strings.Join(parts, "; ")
	}
	return result, nil
}

func neteaseQRRequest(path string, form url.Values) (map[string]interface{}, map[string]string, error) {
	request, err := http.NewRequest(http.MethodPost, neteaseBaseURL+path, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, nil, err
	}
	request.Header.Set("User-Agent", browserUserAgent)
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := extensionHTTPClient.Do(request)
	if err != nil {
		return nil, nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, nil, fmt.Errorf("netease QR request returned %s", response.Status)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return nil, nil, err
	}
	payload := make(map[string]interface{})
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, nil, err
	}
	cookies := make(map[string]string)
	for _, cookie := range response.Cookies() {
		cookies[cookie.Name] = cookie.Value
	}
	return payload, cookies, nil
}

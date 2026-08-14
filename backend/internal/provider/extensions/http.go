package extensions

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36"

var extensionHTTPClient = &http.Client{Timeout: 30 * time.Second}

func getJSON(rawURL, cookie string, headers http.Header) (map[string]interface{}, error) {
	return requestJSON(http.MethodGet, rawURL, cookie, headers, nil, nil)
}

func postFormJSON(rawURL, cookie string, form url.Values) (map[string]interface{}, error) {
	headers := make(http.Header)
	headers.Set("Content-Type", "application/x-www-form-urlencoded")
	return requestJSON(http.MethodPost, rawURL, cookie, headers, strings.NewReader(form.Encode()), nil)
}

func postJSON(rawURL, cookie string, headers http.Header, payload interface{}) (map[string]interface{}, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	if headers == nil {
		headers = make(http.Header)
	}
	headers.Set("Content-Type", "application/json")
	return requestJSON(http.MethodPost, rawURL, cookie, headers, bytes.NewReader(body), nil)
}

func requestJSON(method, rawURL, cookie string, headers http.Header, body io.Reader, target map[string]interface{}) (map[string]interface{}, error) {
	raw, err := requestBytes(method, rawURL, cookie, headers, body)
	if err != nil {
		return nil, err
	}
	if target == nil {
		target = make(map[string]interface{})
	}
	if err := json.Unmarshal(raw, &target); err != nil {
		return nil, fmt.Errorf("decode platform response: %w", err)
	}
	return target, nil
}

func requestBytes(method, rawURL, cookie string, headers http.Header, body io.Reader) ([]byte, error) {
	request, err := http.NewRequest(method, rawURL, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", browserUserAgent)
	request.Header.Set("Accept", "application/json, text/plain, */*")
	if strings.TrimSpace(cookie) != "" {
		request.Header.Set("Cookie", strings.TrimSpace(cookie))
	}
	for key, values := range headers {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	response, err := extensionHTTPClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("platform request returned %s", response.Status)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	if !utf8.Valid(raw) {
		if decoded, decodeErr := simplifiedchinese.GB18030.NewDecoder().Bytes(raw); decodeErr == nil {
			raw = decoded
		}
	}
	return raw, nil
}

func getSingleQuotedJSON(rawURL, cookie string, headers http.Header) (map[string]interface{}, error) {
	raw, err := requestBytes(http.MethodGet, rawURL, cookie, headers, nil)
	if err != nil {
		return nil, err
	}
	result := make(map[string]interface{})
	if err := json.Unmarshal(raw, &result); err == nil {
		return result, nil
	}
	normalized, err := normalizeSingleQuotedJSON(raw)
	if err != nil {
		return nil, fmt.Errorf("normalize single-quoted platform response: %w", err)
	}
	if err := json.Unmarshal(normalized, &result); err != nil {
		return nil, fmt.Errorf("decode single-quoted platform response: %w", err)
	}
	return result, nil
}

func normalizeSingleQuotedJSON(raw []byte) ([]byte, error) {
	result := make([]byte, 0, len(raw))
	quote := byte(0)
	for index := 0; index < len(raw); index++ {
		current := raw[index]
		if quote == 0 {
			if current == '\'' {
				quote = current
				result = append(result, '"')
				continue
			}
			if current == '"' {
				quote = current
			}
			result = append(result, current)
			continue
		}

		if quote == '"' {
			result = append(result, current)
			if current == '\\' && index+1 < len(raw) {
				index++
				result = append(result, raw[index])
				continue
			}
			if current == '"' {
				quote = 0
			}
			continue
		}

		if current == '\\' && index+1 < len(raw) {
			next := raw[index+1]
			if next == '\'' {
				result = append(result, '\'')
				index++
				continue
			}
			result = append(result, current, next)
			index++
			continue
		}
		if current == '"' {
			result = append(result, '\\', '"')
			continue
		}
		if current == '\'' && singleQuoteClosesValue(raw, index+1) {
			result = append(result, '"')
			quote = 0
			continue
		}
		result = append(result, current)
	}
	if quote != 0 {
		return nil, fmt.Errorf("unterminated quoted value")
	}
	return result, nil
}

func singleQuoteClosesValue(raw []byte, start int) bool {
	for index := start; index < len(raw); index++ {
		switch raw[index] {
		case ' ', '\t', '\r', '\n':
			continue
		case ':', ',', '}', ']':
			return true
		default:
			return false
		}
	}
	return true
}

func object(value interface{}) map[string]interface{} {
	result, _ := value.(map[string]interface{})
	return result
}

func array(value interface{}) []interface{} {
	result, _ := value.([]interface{})
	return result
}

func at(value interface{}, keys ...string) interface{} {
	current := value
	for _, key := range keys {
		current = object(current)[key]
		if current == nil {
			return nil
		}
	}
	return current
}

func text(value interface{}) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	case float64:
		if typed == float64(int64(typed)) {
			return strconv.FormatInt(int64(typed), 10)
		}
	}
	return ""
}

func integer(value interface{}) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(typed))
		return parsed
	}
	return 0
}

func int64Value(value interface{}) int64 {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return parsed
	case string:
		parsed, _ := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return parsed
	}
	return 0
}

func boolValue(value interface{}) bool {
	result, _ := value.(bool)
	return result
}

func joinNames(items interface{}, nameKey string) string {
	names := make([]string, 0)
	for _, item := range array(items) {
		if name := text(object(item)[nameKey]); name != "" {
			names = append(names, name)
		}
	}
	return strings.Join(names, ", ")
}

func cloneExtra(values map[string]string) map[string]string {
	if values == nil {
		return nil
	}
	result := make(map[string]string, len(values))
	for key, value := range values {
		result[key] = value
	}
	return result
}

func firstText(values map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if value := text(values[key]); value != "" {
			return value
		}
	}
	return ""
}

func firstInteger(values map[string]interface{}, keys ...string) int {
	for _, key := range keys {
		if value := integer(values[key]); value != 0 {
			return value
		}
	}
	return 0
}

func firstInt64(values map[string]interface{}, keys ...string) int64 {
	for _, key := range keys {
		if value := int64Value(values[key]); value != 0 {
			return value
		}
	}
	return 0
}

func replaceImageSize(value, size string) string {
	return strings.ReplaceAll(strings.TrimSpace(value), "{size}", strings.TrimSpace(size))
}

func splitArtistTitle(value string) (string, string) {
	parts := strings.SplitN(strings.TrimSpace(value), " - ", 2)
	if len(parts) != 2 {
		return "", strings.TrimSpace(value)
	}
	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
}

func linkID(rawLink string, queryKeys ...string) string {
	parsed, err := url.Parse(strings.TrimSpace(rawLink))
	if err != nil {
		return ""
	}
	for _, key := range queryKeys {
		if value := strings.TrimSpace(parsed.Query().Get(key)); value != "" {
			return value
		}
	}
	base := strings.TrimSpace(path.Base(strings.TrimSuffix(parsed.Path, "/")))
	if base == "." || base == "/" {
		return ""
	}
	return base
}

package web

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	playbackTicketQueryName     = "playback_token"
	playbackTicketMaxAgeEnv     = "MUSIC_DL_PLAYBACK_TICKET_MAX_AGE"
	defaultPlaybackTicketMaxAge = 6 * time.Hour
	minPlaybackTicketMaxAge     = 5 * time.Minute
)

var playbackTicketQueryKeys = map[string]struct{}{
	"album":    {},
	"artist":   {},
	"cover":    {},
	"duration": {},
	"extra":    {},
	"id":       {},
	"name":     {},
	"source":   {},
	"stream":   {},
}

type playbackTicketPayload struct {
	UserID    uint   `json:"uid"`
	Username  string `json:"u"`
	Epoch     int    `json:"e"`
	IssuedAt  int64  `json:"iat"`
	Nonce     string `json:"n"`
	QueryHash string `json:"qh"`
}

type playbackTicketRequest struct {
	Query string `json:"query"`
}

func playbackTicketMaxAge() time.Duration {
	if raw := strings.TrimSpace(os.Getenv(playbackTicketMaxAgeEnv)); raw != "" {
		if duration, err := time.ParseDuration(raw); err == nil && duration >= minPlaybackTicketMaxAge {
			if sessionAge := sessionMaxAge(); duration > sessionAge {
				return sessionAge
			}
			return duration
		}
	}
	if sessionAge := sessionMaxAge(); sessionAge < defaultPlaybackTicketMaxAge {
		return sessionAge
	}
	return defaultPlaybackTicketMaxAge
}

func canonicalPlaybackQuery(rawQuery string) (string, error) {
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		return "", fmt.Errorf("播放参数无效: %w", err)
	}
	if _, exists := values[playbackTicketQueryName]; exists {
		return "", errors.New("播放参数不得包含既有票据")
	}
	return canonicalPlaybackValues(values)
}

func canonicalPlaybackValues(values url.Values) (string, error) {
	for key, entries := range values {
		if _, allowed := playbackTicketQueryKeys[key]; !allowed {
			return "", fmt.Errorf("播放参数 %q 不受支持", key)
		}
		if len(entries) != 1 {
			return "", fmt.Errorf("播放参数 %q 必须唯一", key)
		}
	}
	if strings.TrimSpace(values.Get("id")) == "" || strings.TrimSpace(values.Get("source")) == "" {
		return "", errors.New("播放参数缺少 id/source")
	}
	if values.Get("stream") != "1" {
		return "", errors.New("播放票据仅允许 stream=1")
	}
	return values.Encode(), nil
}

func playbackQueryHash(canonicalQuery string) string {
	sum := sha256.Sum256([]byte(canonicalQuery))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func signPlaybackTicketPayload(secret, encodedPayload string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("melodex-playback-ticket:"))
	mac.Write([]byte(encodedPayload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func createPlaybackTicket(user *User, canonicalQuery string, now time.Time) (string, error) {
	if user == nil || user.ID == 0 {
		return "", errors.New("invalid user for playback ticket")
	}
	secret, err := signingSecret()
	if err != nil {
		return "", err
	}
	nonce, err := randomToken(18)
	if err != nil {
		return "", err
	}
	payload := playbackTicketPayload{
		UserID:    user.ID,
		Username:  user.Username,
		Epoch:     user.SessionEpoch,
		IssuedAt:  now.Unix(),
		Nonce:     nonce,
		QueryHash: playbackQueryHash(canonicalQuery),
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	encodedPayload := base64.RawURLEncoding.EncodeToString(raw)
	return encodedPayload + "." + signPlaybackTicketPayload(secret, encodedPayload), nil
}

func parsePlaybackTicketValue(
	secret, value, canonicalQuery string,
	now time.Time,
) (playbackTicketPayload, bool) {
	var payload playbackTicketPayload
	parts := strings.Split(value, ".")
	if strings.TrimSpace(secret) == "" || len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return payload, false
	}
	expectedSignature := signPlaybackTicketPayload(secret, parts[0])
	if subtle.ConstantTimeCompare([]byte(parts[1]), []byte(expectedSignature)) != 1 {
		return payload, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(raw, &payload) != nil {
		return playbackTicketPayload{}, false
	}
	if payload.UserID == 0 || payload.IssuedAt <= 0 || strings.TrimSpace(payload.Nonce) == "" {
		return playbackTicketPayload{}, false
	}
	issuedAt := time.Unix(payload.IssuedAt, 0)
	if issuedAt.After(now.Add(2*time.Minute)) || now.Sub(issuedAt) > playbackTicketMaxAge() {
		return playbackTicketPayload{}, false
	}
	expectedHash := playbackQueryHash(canonicalQuery)
	if subtle.ConstantTimeCompare([]byte(payload.QueryHash), []byte(expectedHash)) != 1 {
		return playbackTicketPayload{}, false
	}
	return payload, true
}

func authenticatePlaybackTicketRequest(c *gin.Context, now time.Time) (*User, bool, error) {
	if c.Request.Method != http.MethodGet || c.Request.URL.Path != RoutePrefix+"/download" {
		return nil, false, nil
	}
	values := c.Request.URL.Query()
	tokens := values[playbackTicketQueryName]
	if len(tokens) != 1 || strings.TrimSpace(tokens[0]) == "" {
		return nil, false, nil
	}
	values.Del(playbackTicketQueryName)
	canonicalQuery, err := canonicalPlaybackValues(values)
	if err != nil {
		return nil, false, nil
	}
	secret, err := signingSecret()
	if err != nil {
		return nil, false, err
	}
	payload, valid := parsePlaybackTicketValue(secret, tokens[0], canonicalQuery, now)
	if !valid {
		return nil, false, nil
	}
	return authenticatedUserForIdentity(payload.UserID, payload.Username, payload.Epoch)
}

func jsonPlaybackTicketHandler(c *gin.Context) {
	var request playbackTicketRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "播放票据请求格式无效"})
		return
	}
	canonicalQuery, err := canonicalPlaybackQuery(request.Query)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	user, err := findUserByID(currentUserID(c))
	if err != nil || user == nil || user.Disabled {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "登录状态已失效"})
		return
	}
	ticket, err := createPlaybackTicket(user, canonicalQuery, time.Now())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "签发播放票据失败"})
		return
	}
	streamURL := RoutePrefix + "/download?" + canonicalQuery + "&" +
		playbackTicketQueryName + "=" + url.QueryEscape(ticket)
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"url": streamURL})
}

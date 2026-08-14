package web

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/gin-gonic/gin"
)

const (
	authCookieName       = "music_dl_session"
	sessionMaxAgeEnv     = "MUSIC_DL_SESSION_MAX_AGE"
	sessionDaysEnv       = "MUSIC_DL_SESSION_DAYS"
	defaultSessionMaxAge = 180 * 24 * time.Hour
	minSessionMaxAge     = time.Hour
	maxSessionMaxAge     = 3650 * 24 * time.Hour
	minAuthPasswordSize  = 8
	setupTokenBytes      = 24
	loginLockBaseDelay   = time.Second
	loginLockMaxDelay    = time.Minute
	maxLoginAttemptKeys  = 4096
)

type sessionPayload struct {
	UserID   uint   `json:"uid"`
	Username string `json:"u"`
	Epoch    int    `json:"e"`
	IssuedAt int64  `json:"iat"`
	Nonce    string `json:"n"`
}

type loginAttemptState struct {
	Failures    int
	LockedUntil time.Time
	LastSeen    time.Time
}

type authRuntimeState struct {
	mu            sync.Mutex
	setupToken    string
	sessionSecret string
	loginAttempts map[string]loginAttemptState
}

func newAuthRuntimeState() *authRuntimeState {
	return &authRuntimeState{loginAttempts: make(map[string]loginAttemptState)}
}

var authRuntime = newAuthRuntimeState()

func resetAuthRuntimeForTest() {
	authRuntime = newAuthRuntimeState()
}

func prepareSetupToken(configured bool) (string, error) {
	authRuntime.mu.Lock()
	defer authRuntime.mu.Unlock()
	if configured {
		authRuntime.setupToken = ""
		return "", nil
	}
	if authRuntime.setupToken != "" {
		return authRuntime.setupToken, nil
	}
	token, err := randomToken(setupTokenBytes)
	if err != nil {
		return "", err
	}
	authRuntime.setupToken = token
	return token, nil
}

func currentSetupToken() string {
	authRuntime.mu.Lock()
	defer authRuntime.mu.Unlock()
	return authRuntime.setupToken
}

func consumeSetupToken() {
	authRuntime.mu.Lock()
	authRuntime.setupToken = ""
	authRuntime.mu.Unlock()
}

func loginAttemptKey(c *gin.Context, username string) string {
	ip := "unknown"
	if c != nil {
		ip = c.ClientIP()
	}
	return strings.ToLower(strings.TrimSpace(username)) + "|" + ip
}

func loginLockDelay(failures int) time.Duration {
	if failures <= 0 {
		return 0
	}
	delay := loginLockBaseDelay << min(failures-1, 6)
	return min(delay, loginLockMaxDelay)
}

func loginLockedUntil(key string, now time.Time) (time.Time, bool) {
	authRuntime.mu.Lock()
	defer authRuntime.mu.Unlock()
	attempt, exists := authRuntime.loginAttempts[key]
	return attempt.LockedUntil, exists && attempt.LockedUntil.After(now)
}

func recordLoginFailure(key string, now time.Time) time.Time {
	authRuntime.mu.Lock()
	defer authRuntime.mu.Unlock()
	pruneLoginAttemptsLocked(now)
	attempt := authRuntime.loginAttempts[key]
	attempt.Failures++
	attempt.LastSeen = now
	attempt.LockedUntil = now.Add(loginLockDelay(attempt.Failures))
	authRuntime.loginAttempts[key] = attempt
	return attempt.LockedUntil
}

func pruneLoginAttemptsLocked(now time.Time) {
	if len(authRuntime.loginAttempts) < maxLoginAttemptKeys {
		return
	}
	cutoff := now.Add(-2 * loginLockMaxDelay)
	for key, attempt := range authRuntime.loginAttempts {
		if attempt.LastSeen.Before(cutoff) && !attempt.LockedUntil.After(now) {
			delete(authRuntime.loginAttempts, key)
		}
	}
	for len(authRuntime.loginAttempts) >= maxLoginAttemptKeys {
		var oldestKey string
		var oldestTime time.Time
		for key, attempt := range authRuntime.loginAttempts {
			if oldestKey == "" || attempt.LastSeen.Before(oldestTime) {
				oldestKey, oldestTime = key, attempt.LastSeen
			}
		}
		delete(authRuntime.loginAttempts, oldestKey)
	}
}

func clearLoginFailures(key string) {
	authRuntime.mu.Lock()
	delete(authRuntime.loginAttempts, key)
	authRuntime.mu.Unlock()
}

func randomToken(byteLength int) (string, error) {
	buffer := make([]byte, byteLength)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func sessionMaxAge() time.Duration {
	if configured := durationWithin(os.Getenv(sessionMaxAgeEnv), minSessionMaxAge, maxSessionMaxAge); configured > 0 {
		return configured
	}
	if rawDays := strings.TrimSpace(os.Getenv(sessionDaysEnv)); rawDays != "" {
		if days, err := strconv.Atoi(rawDays); err == nil {
			if duration := time.Duration(days) * 24 * time.Hour; duration >= minSessionMaxAge && duration <= maxSessionMaxAge {
				return duration
			}
		}
	}
	return defaultSessionMaxAge
}

func durationWithin(raw string, minimum, maximum time.Duration) time.Duration {
	duration, err := time.ParseDuration(strings.TrimSpace(raw))
	if err != nil || duration < minimum || duration > maximum {
		return 0
	}
	return duration
}

func signingSecret() (string, error) {
	authRuntime.mu.Lock()
	defer authRuntime.mu.Unlock()
	if authRuntime.sessionSecret != "" {
		return authRuntime.sessionSecret, nil
	}
	settings, err := core.GetWebAuthSettings()
	if err != nil {
		return "", err
	}
	if secret := strings.TrimSpace(settings.SessionSecret); secret != "" {
		authRuntime.sessionSecret = secret
		return secret, nil
	}
	secret, err := randomToken(32)
	if err != nil {
		return "", err
	}
	settings.SessionSecret = secret
	if err := core.SaveWebAuthSettings(settings); err != nil {
		return "", err
	}
	authRuntime.sessionSecret = secret
	return secret, nil
}

func createUserSession(user *User, now time.Time) (string, error) {
	if user == nil || user.ID == 0 {
		return "", errors.New("invalid user for session")
	}
	secret, err := signingSecret()
	if err != nil {
		return "", err
	}
	nonce, err := randomToken(18)
	if err != nil {
		return "", err
	}
	payload := sessionPayload{
		UserID: user.ID, Username: user.Username, Epoch: user.SessionEpoch,
		IssuedAt: now.Unix(), Nonce: nonce,
	}
	encoded, err := encodeSessionPayload(payload)
	if err != nil {
		return "", err
	}
	return encoded + "." + signSessionPayload(secret, encoded), nil
}

func encodeSessionPayload(payload sessionPayload) (string, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func signSessionPayload(secret, encodedPayload string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(encodedPayload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func parseSessionValue(secret, value string, now time.Time) (sessionPayload, bool) {
	var payload sessionPayload
	parts := strings.Split(value, ".")
	if secret == "" || len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return payload, false
	}
	expected := signSessionPayload(secret, parts[0])
	if subtle.ConstantTimeCompare([]byte(parts[1]), []byte(expected)) != 1 {
		return payload, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(raw, &payload) != nil {
		return sessionPayload{}, false
	}
	if payload.UserID == 0 || payload.IssuedAt <= 0 || strings.TrimSpace(payload.Nonce) == "" {
		return sessionPayload{}, false
	}
	issuedAt := time.Unix(payload.IssuedAt, 0)
	if issuedAt.After(now.Add(2*time.Minute)) || now.Sub(issuedAt) > sessionMaxAge() {
		return sessionPayload{}, false
	}
	return payload, true
}

func authenticatedUserForIdentity(userID uint, username string, epoch int) (*User, bool, error) {
	user, err := findUserByID(userID)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			return nil, false, nil
		}
		return nil, false, err
	}
	if user == nil || user.Disabled || user.Username != username || user.SessionEpoch != epoch {
		return nil, false, nil
	}
	return user, true, nil
}

func setupErrorMessage(err error) string {
	switch {
	case errors.Is(err, ErrInvalidUsername):
		return "用户名需 2-32 个字符且不含空白"
	case errors.Is(err, ErrInvalidPassword):
		return fmt.Sprintf("密码至少 %d 位,且不能是常见弱密码", minAuthPasswordSize)
	case errors.Is(err, ErrUsernameTaken):
		return "用户名已存在"
	default:
		return "创建账号失败"
	}
}

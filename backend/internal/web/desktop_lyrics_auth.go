package web

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const (
	desktopLyricsPairingTTL      = 5 * time.Minute
	desktopLyricsPairCodeBytes   = 10
	desktopLyricsDeviceTokenSize = 32
	desktopLyricsMaxDeviceName   = 64
)

// DesktopLyricsDevice 是透明桌面歌词助手的可吊销凭据。
// TokenHash 只保存设备令牌的 SHA-256，服务端和数据库都不保存令牌明文。
type DesktopLyricsDevice struct {
	ID           uint       `gorm:"primaryKey" json:"id"`
	UserID       uint       `gorm:"not null;index" json:"-"`
	Name         string     `gorm:"size:64;not null" json:"name"`
	TokenHash    string     `gorm:"size:64;uniqueIndex;not null" json:"-"`
	SessionEpoch int        `gorm:"not null" json:"-"`
	LastSeenAt   *time.Time `json:"last_seen_at,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"-"`
}

type desktopLyricsPairing struct {
	UserID       uint
	SessionEpoch int
	ExpiresAt    time.Time
}

type desktopLyricsPairingStore struct {
	mu      sync.Mutex
	entries map[string]desktopLyricsPairing
}

var (
	errDesktopLyricsPairingInvalid = errors.New("配对码无效或已过期")
	desktopLyricsPairings          = &desktopLyricsPairingStore{entries: make(map[string]desktopLyricsPairing)}
	desktopLyricsPairLimit         = newRateLimiter(10, time.Minute)
)

type desktopLyricsPairRequest struct {
	Code       string `json:"code"`
	DeviceName string `json:"device_name"`
}

type desktopLyricsPairResponse struct {
	DeviceID    uint   `json:"device_id"`
	DeviceToken string `json:"device_token"`
	DeviceName  string `json:"device_name"`
}

func normalizeDesktopLyricsPairCode(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	code = strings.ReplaceAll(code, "-", "")
	code = strings.ReplaceAll(code, " ", "")
	return code
}

func displayDesktopLyricsPairCode(code string) string {
	normalized := normalizeDesktopLyricsPairCode(code)
	groups := make([]string, 0, (len(normalized)+3)/4)
	for len(normalized) > 0 {
		take := min(4, len(normalized))
		groups = append(groups, normalized[:take])
		normalized = normalized[take:]
	}
	return strings.Join(groups, "-")
}

func newDesktopLyricsPairCode() (string, error) {
	raw := make([]byte, desktopLyricsPairCodeBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw), nil
}

func createDesktopLyricsPairing(userID uint, sessionEpoch int, now time.Time) (string, time.Time, error) {
	if userID == 0 {
		return "", time.Time{}, errors.New("invalid desktop lyrics pairing user")
	}

	desktopLyricsPairings.mu.Lock()
	defer desktopLyricsPairings.mu.Unlock()
	for code, entry := range desktopLyricsPairings.entries {
		if !entry.ExpiresAt.After(now) || entry.UserID == userID {
			delete(desktopLyricsPairings.entries, code)
		}
	}

	for range 4 {
		code, err := newDesktopLyricsPairCode()
		if err != nil {
			return "", time.Time{}, err
		}
		if _, exists := desktopLyricsPairings.entries[code]; exists {
			continue
		}
		expiresAt := now.Add(desktopLyricsPairingTTL)
		desktopLyricsPairings.entries[code] = desktopLyricsPairing{
			UserID:       userID,
			SessionEpoch: sessionEpoch,
			ExpiresAt:    expiresAt,
		}
		return displayDesktopLyricsPairCode(code), expiresAt, nil
	}
	return "", time.Time{}, errors.New("failed to allocate desktop lyrics pairing code")
}

func consumeDesktopLyricsPairing(code string, now time.Time) (desktopLyricsPairing, bool) {
	normalized := normalizeDesktopLyricsPairCode(code)
	if normalized == "" {
		return desktopLyricsPairing{}, false
	}

	desktopLyricsPairings.mu.Lock()
	defer desktopLyricsPairings.mu.Unlock()
	entry, ok := desktopLyricsPairings.entries[normalized]
	if !ok {
		return desktopLyricsPairing{}, false
	}
	delete(desktopLyricsPairings.entries, normalized)
	if !entry.ExpiresAt.After(now) {
		return desktopLyricsPairing{}, false
	}
	return entry, true
}

func desktopLyricsTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func normalizedDesktopLyricsDeviceName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "桌面歌词助手"
	}
	runes := []rune(name)
	if len(runes) > desktopLyricsMaxDeviceName {
		name = string(runes[:desktopLyricsMaxDeviceName])
	}
	return name
}

func pairDesktopLyricsDevice(req desktopLyricsPairRequest, now time.Time) (desktopLyricsPairResponse, error) {
	entry, ok := consumeDesktopLyricsPairing(req.Code, now)
	if !ok {
		return desktopLyricsPairResponse{}, errDesktopLyricsPairingInvalid
	}
	u, err := findUserByID(entry.UserID)
	if err != nil || u == nil || u.Disabled || u.SessionEpoch != entry.SessionEpoch {
		if err != nil && !errors.Is(err, ErrUserNotFound) {
			return desktopLyricsPairResponse{}, err
		}
		return desktopLyricsPairResponse{}, errDesktopLyricsPairingInvalid
	}
	token, err := randomToken(desktopLyricsDeviceTokenSize)
	if err != nil {
		return desktopLyricsPairResponse{}, err
	}
	device := DesktopLyricsDevice{
		UserID:       u.ID,
		Name:         normalizedDesktopLyricsDeviceName(req.DeviceName),
		TokenHash:    desktopLyricsTokenHash(token),
		SessionEpoch: u.SessionEpoch,
	}
	if err := db.Create(&device).Error; err != nil {
		return desktopLyricsPairResponse{}, err
	}
	return desktopLyricsPairResponse{
		DeviceID:    device.ID,
		DeviceToken: token,
		DeviceName:  device.Name,
	}, nil
}

func authenticateDesktopLyricsDevice(token string, now time.Time) (*DesktopLyricsDevice, *User, bool, error) {
	token = strings.TrimSpace(token)
	if token == "" || db == nil {
		return nil, nil, false, nil
	}
	var device DesktopLyricsDevice
	if err := db.Where("token_hash = ?", desktopLyricsTokenHash(token)).First(&device).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil, false, nil
		}
		return nil, nil, false, err
	}
	u, err := findUserByID(device.UserID)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			return nil, nil, false, nil
		}
		return nil, nil, false, err
	}
	if u == nil || u.Disabled || u.SessionEpoch != device.SessionEpoch {
		return nil, nil, false, nil
	}
	seenAt := now.UTC()
	if err := db.Model(&DesktopLyricsDevice{}).Where("id = ?", device.ID).UpdateColumn("last_seen_at", seenAt).Error; err != nil {
		return nil, nil, false, err
	}
	device.LastSeenAt = &seenAt
	return &device, u, true, nil
}

func desktopLyricsDeviceStillValid(deviceID, userID uint, sessionEpoch int) bool {
	if deviceID == 0 || userID == 0 || db == nil {
		return false
	}
	var count int64
	err := db.Table("desktop_lyrics_devices AS d").
		Joins("JOIN users AS u ON u.id = d.user_id").
		Where("d.id = ? AND d.user_id = ? AND d.session_epoch = ? AND u.session_epoch = ? AND u.disabled = ?", deviceID, userID, sessionEpoch, sessionEpoch, false).
		Count(&count).Error
	if err != nil {
		log.Printf("desktop lyrics device validation failed: %v", err)
	}
	return err == nil && count == 1
}

func resetDesktopLyricsRuntimeForTest() {
	desktopLyricsPairings = &desktopLyricsPairingStore{entries: make(map[string]desktopLyricsPairing)}
	desktopLyricsPairLimit = newRateLimiter(10, time.Minute)
	desktopLyricsHub = newDesktopLyricsHub()
}

// RegisterDesktopLyricsRoutes 注册浏览器桥和原生助手端点。
// 浏览器桥复用 Melodex 登录；/rest 下的助手端点只接受一次性配对码或设备令牌。
func RegisterDesktopLyricsRoutes(r *gin.Engine, opts StartOptions) {
	browser := r.Group("/api/v1/desktop-lyrics")
	if opts.DisableAuth {
		browser.Use(desktopUserMiddleware())
	} else {
		browser.Use(authRequired())
	}
	browser.POST("/pairing", createDesktopLyricsPairingHandler)
	browser.GET("/devices", listDesktopLyricsDevicesHandler)
	browser.DELETE("/devices/:id", deleteDesktopLyricsDeviceHandler)
	browser.GET("/browser", desktopLyricsBrowserWebSocketHandler)

	device := r.Group("/rest/desktop-lyrics")
	device.POST("/pair", rateLimitMiddleware(desktopLyricsPairLimit), pairDesktopLyricsDeviceHandler)
	device.GET("/device", desktopLyricsDeviceWebSocketHandler)
}

func createDesktopLyricsPairingHandler(c *gin.Context) {
	if !allowSameOriginWrite(c) {
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return
	}
	u, err := findUserByID(currentUserID(c))
	if err != nil {
		if !errors.Is(err, ErrUserNotFound) {
			log.Printf("create desktop lyrics pairing: load user failed: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "读取账号失败"})
			return
		}
		c.JSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
		return
	}
	if u == nil || u.Disabled {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
		return
	}
	code, expiresAt, err := createDesktopLyricsPairing(u.ID, u.SessionEpoch, time.Now())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "生成配对码失败"})
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"code": code, "expires_at": expiresAt.UTC()})
}

func pairDesktopLyricsDeviceHandler(c *gin.Context) {
	var req desktopLyricsPairRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的配对请求"})
		return
	}
	paired, err := pairDesktopLyricsDevice(req, time.Now())
	if err != nil {
		if errors.Is(err, errDesktopLyricsPairingInvalid) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": errDesktopLyricsPairingInvalid.Error()})
			return
		}
		log.Printf("pair desktop lyrics device failed: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "保存桌面歌词设备失败"})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, paired)
}

func listDesktopLyricsDevicesHandler(c *gin.Context) {
	var devices []DesktopLyricsDevice
	if err := db.Where("user_id = ?", currentUserID(c)).Order("id ASC").Find(&devices).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "读取桌面歌词设备失败"})
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"devices": devices})
}

func deleteDesktopLyricsDeviceHandler(c *gin.Context) {
	if !allowSameOriginWrite(c) {
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return
	}
	id64, err := strconv.ParseUint(strings.TrimSpace(c.Param("id")), 10, 64)
	if err != nil || id64 == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的设备 id"})
		return
	}
	id := uint(id64)
	userID := currentUserID(c)
	result := db.Where("id = ? AND user_id = ?", id, userID).Delete(&DesktopLyricsDevice{})
	if result.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "删除桌面歌词设备失败"})
		return
	}
	if result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "设备不存在"})
		return
	}
	desktopLyricsHub.disconnectDevice(userID, id)
	c.Status(http.StatusNoContent)
}

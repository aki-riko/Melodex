package core

import (
	"crypto/sha256"
	"encoding/hex"
	"log"
	"sort"
	"strings"
	"sync"

	"github.com/aki-riko/Melodex/backend/internal/provider/extensions"
	"gorm.io/gorm"
)

const CookieFile = "data/cookies.json"

type CookieManager struct {
	mu      sync.RWMutex
	cookies map[string]string
}

var CM = &CookieManager{cookies: make(map[string]string)}

type CookieStatusDetail struct {
	Source       string          `json:"source"`
	Saved        bool            `json:"saved"`
	Verifiable   bool            `json:"verifiable"`
	VIPChecked   bool            `json:"vip_checked"`
	VIP          bool            `json:"vip"`
	Error        string          `json:"error,omitempty"`
	CookieLength int             `json:"cookie_length,omitempty"`
	Hints        map[string]bool `json:"hints,omitempty"`
}

func (manager *CookieManager) Load() {
	if err := ensureConfigDB(); err != nil {
		log.Printf("[cookies] open settings database: %v", err)
		return
	}

	var rows []cookieEntry
	if err := configDB.Order("source ASC").Find(&rows).Error; err != nil {
		log.Printf("[cookies] load entries: %v", err)
		return
	}

	loaded := make(map[string]string, len(rows))
	for _, row := range rows {
		if source, value := strings.TrimSpace(row.Source), strings.TrimSpace(row.Value); source != "" && value != "" {
			loaded[source] = value
		}
	}
	manager.mu.Lock()
	manager.cookies = loaded
	manager.mu.Unlock()
}

func (manager *CookieManager) Save() {
	if err := ensureConfigDB(); err != nil {
		log.Printf("[cookies] open settings database: %v", err)
		return
	}

	manager.mu.RLock()
	rows := make([]cookieEntry, 0, len(manager.cookies))
	for source, value := range manager.cookies {
		source = strings.TrimSpace(source)
		value = strings.TrimSpace(value)
		if source != "" && value != "" {
			rows = append(rows, cookieEntry{Source: source, Value: value})
		}
	}
	manager.mu.RUnlock()
	sort.Slice(rows, func(left, right int) bool { return rows[left].Source < rows[right].Source })

	err := configDB.Transaction(func(tx *gorm.DB) error { return replaceCookieEntries(tx, rows) })
	if err != nil {
		log.Printf("[cookies] save entries: %v", err)
	}
}

func replaceCookieEntries(tx *gorm.DB, rows []cookieEntry) error {
	if err := tx.Session(&gorm.Session{AllowGlobalUpdate: true}).Delete(&cookieEntry{}).Error; err != nil {
		return err
	}
	if len(rows) > 0 {
		return tx.Create(&rows).Error
	}
	return nil
}

func (manager *CookieManager) Get(source string) string {
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	return manager.cookies[strings.TrimSpace(source)]
}

func (manager *CookieManager) SetAll(updates map[string]string) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.cookies == nil {
		manager.cookies = make(map[string]string)
	}
	for source, value := range updates {
		source = strings.TrimSpace(source)
		value = strings.TrimSpace(value)
		if source == "" {
			continue
		}
		if value == "" {
			delete(manager.cookies, source)
		} else {
			manager.cookies[source] = value
		}
	}
}

func (manager *CookieManager) GetAll() map[string]string {
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	copyOfCookies := make(map[string]string, len(manager.cookies))
	for source, value := range manager.cookies {
		copyOfCookies[source] = value
	}
	return copyOfCookies
}

func cookieForSource(source string) string {
	return CM.Get(canonicalCookieSource(source))
}

func canonicalCookieSource(source string) string {
	switch strings.TrimSpace(source) {
	case "qq_wx", "qq_mobile", "qq_connect":
		return "qq"
	default:
		return strings.TrimSpace(source)
	}
}

func CookieFingerprintForSource(source string) string {
	cookie := cookieForSource(source)
	if cookie == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(cookie))
	return hex.EncodeToString(digest[:])
}

func BuildCookieStatusDetail(source, cookie string, verify bool) CookieStatusDetail {
	source = canonicalCookieSource(source)
	cookie = strings.TrimSpace(cookie)
	detail := CookieStatusDetail{
		Source:       source,
		Saved:        cookie != "",
		Verifiable:   source == "netease",
		CookieLength: len(cookie),
		Hints:        credentialHints(source, cookie),
	}
	if !detail.Saved || !verify || !detail.Verifiable {
		return detail
	}

	detail.VIPChecked = true
	vip, err := extensions.NewNetease(cookie).IsVIPAccount()
	if err != nil {
		detail.Error = conciseCookieError(err)
		return detail
	}
	detail.VIP = vip
	return detail
}

func credentialHints(source, cookie string) map[string]bool {
	if strings.TrimSpace(cookie) == "" {
		return nil
	}
	names := cookieNames(cookie)
	has := func(candidates ...string) bool {
		for _, candidate := range candidates {
			if names[candidate] {
				return true
			}
		}
		return false
	}

	switch canonicalCookieSource(source) {
	case "netease":
		return map[string]bool{"has_music_u": names["MUSIC_U"]}
	case "qq":
		return map[string]bool{
			"has_uin":           has("str_musicid", "qqmusic_uin", "musicid", "uin"),
			"has_music_key":     has("musickey", "qqmusic_key", "qm_keyst"),
			"has_musickey":      names["musickey"],
			"has_qqmusic_key":   names["qqmusic_key"],
			"has_qm_keyst":      names["qm_keyst"],
			"has_refresh_key":   names["refresh_key"],
			"has_refresh_token": has("refresh_token", "psrf_qqrefresh_token"),
		}
	case "kugou":
		return map[string]bool{
			"has_token":  has("token", "KuGoo", "kguser"),
			"has_kg_mid": names["kg_mid"],
		}
	case "bilibili":
		return map[string]bool{"has_sessdata": names["SESSDATA"]}
	case "soda":
		return map[string]bool{
			"has_sessionid": has("sessionid", "sessionid_ss"),
			"has_passport":  has("passport_csrf_token", "passport_auth_status", "sid_guard"),
		}
	default:
		return nil
	}
}

func cookieNames(raw string) map[string]bool {
	names := make(map[string]bool)
	for _, part := range strings.Split(raw, ";") {
		name, value, found := strings.Cut(part, "=")
		name = strings.TrimSpace(name)
		value = strings.TrimSpace(value)
		if found && name != "" && value != "" {
			names[name] = true
		}
	}
	return names
}

func conciseCookieError(err error) string {
	if err == nil {
		return ""
	}
	message := strings.NewReplacer("\r", " ", "\n", " ").Replace(strings.TrimSpace(err.Error()))
	if len(message) > 240 {
		return message[:240] + "..."
	}
	return message
}

package core

import (
	"crypto/sha256"
	"encoding/hex"
	"log"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

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

	// 凭证有效期。用户反馈"凭证过期后没有任何提示,只是音质悄悄变差",所以把
	// 「还能用多久」做成结构化字段,前端据此显示徽章/横幅。
	//
	// State 取值:
	//   ok            有效(已知还有充足时间,或探测通过)
	//   expiring_soon 即将过期(剩余 <= 24h,值得提示但仍可用)
	//   expired       已过期/已失效
	//   unknown       无法判断(该源既没有时间戳字段、也无法在线探测)
	//   missing       从未配置
	State            string `json:"state"`
	ExpiresAt        int64  `json:"expires_at,omitempty"`         // unix 秒;0 = 未知
	ExpiresInSeconds int64  `json:"expires_in_seconds,omitempty"` // 剩余秒数;负数 = 已过期
	// ExpirySource 说明这个结论的依据,便于排查:
	//   musickey = 从 cookie 自带的创建时间+有效期算出(QQ)
	//   probe    = 在线探测结果(网易)
	//   none     = 无法判断
	ExpirySource string `json:"expiry_source,omitempty"`
}

// 即将过期的阈值:剩余不足 24h 就值得提醒(QQ musickey 有效期通常是 72h)。
const CookieExpiringSoonSeconds = 24 * 60 * 60

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

	// 先做「离线可算」的有效期判断(QQ 的 musickey 自带创建时间与有效期)。
	// 这一步不联网,所以即使 verify=false 也能给出结论 ——
	// 用户只是打开设置页时也应该看到"还有 52 小时过期"。
	applyCredentialExpiry(&detail, source, cookie)

	if !detail.Saved || !verify || !detail.Verifiable {
		return detail
	}

	detail.VIPChecked = true
	vip, err := verifyProviderAccount(source, cookie)
	if err != nil {
		detail.Error = conciseCookieError(err)
		// 探测失败 = 凭证确实不可用。这是比时间戳更硬的证据,覆盖前面的推断。
		// 注意:只有 verifiable 的源(目前仅网易)能走到这里。
		markCredentialExpired(&detail, "probe", "online probe failed")
		return detail
	}
	detail.VIP = vip
	if detail.Error == "" {
		// 探测成功说明凭证此刻可用:用它兜底覆盖 time-based 的误判
		// (比如机器时钟偏差把"未过期"算成了"已过期")。
		markCredentialValid(&detail, "probe")
	}
	return detail
}

// applyCredentialExpiry 用 cookie 里自带的时间字段推算有效期。
//
// 为什么只对 QQ 做:cookie（腾讯音乐登录态）里带
//   psrf_musickey_createtime / musickeycreatetime  创建时间(unix 秒)
//   keyexpiresin                                   有效期(秒,实测 259200 = 72h)
// 两者相加即到期时间,完全离线可算。
// 网易的 MUSIC_U 没有这类字段,只能靠在线探测;其余源两者都没有,标 unknown。
func applyCredentialExpiry(detail *CookieStatusDetail, source, cookie string) {
	if !detail.Saved {
		detail.State = "missing"
		return
	}

	detail.State = "unknown"
	detail.ExpirySource = "none"

	if source != "qq" {
		// 非 QQ:没有时间戳字段。网易稍后若探测成功会被标成 ok。
		if source == "netease" {
			detail.ExpirySource = "probe"
		}
		return
	}

	values := cookieValuesByLowerName(cookie)
	created := firstInt64(values, "psrf_musickey_createtime", "musickeycreatetime", "musickey_create_time")
	ttl := firstInt64(values, "keyexpiresin", "key_expires_in")
	if created <= 0 {
		return // 没有创建时间就无法推算,保持 unknown(不猜)
	}

	// 兼容毫秒时间戳
	if created > 1e12 {
		created /= 1000
	}

	// ⚠️ 刻意**不用** expired_at / expired_in 这两个字段。
	//
	// 2026-10-25 生产实测:同一份 QQ cookie 里
	//   psrf_musickey_createtime = 1792859361 (2026-10-25 00:29:21)
	//   keyexpiresin             = 259200     (3 天)
	//   expired_at               = 1798043361 (2026-12-24 00:29:21 = 创建 + 60 天)
	// 两者相差 20 倍,说明 expired_at 描述的是另一套 token(如 refresh/access token)
	// 的生命周期,而不是 musickey。用它算会把"3 天后过期"错报成"60 天后过期",
	// 等于让用户在最该被提醒的时候看不到提醒。
	// 所以只认 keyExpiresIn(QQ 音乐强凭证的官方有效期),缺失时按实测默认 72h。
	if ttl <= 0 {
		ttl = 259200
	}

	expiresAt := created + ttl
	detail.ExpiresAt = expiresAt
	detail.ExpiresInSeconds = expiresAt - nowUnix()
	detail.ExpirySource = "musickey"

	switch {
	case detail.ExpiresInSeconds <= 0:
		detail.State = "expired"
	case detail.ExpiresInSeconds <= CookieExpiringSoonSeconds:
		detail.State = "expiring_soon"
	default:
		detail.State = "ok"
	}
}

func markCredentialExpired(detail *CookieStatusDetail, source, reason string) {
	detail.State = "expired"
	detail.ExpirySource = source
	if detail.ExpiresInSeconds > 0 {
		detail.ExpiresInSeconds = 0
	}
}

func markCredentialValid(detail *CookieStatusDetail, source string) {
	if detail.State == "expired" || detail.State == "unknown" || detail.State == "" {
		detail.State = "ok"
		detail.ExpirySource = source
	}
}

// nowUnix 单独抽出来,便于测试里替换(不在测试中依赖真实时钟)。
var nowUnix = func() int64 { return time.Now().Unix() }

// cookieValuesByLowerName 把 cookie 解析成「小写名 → 值」,只用于读取有效期字段。
// 注意:调用方绝不能把值写进日志或 API 响应 —— 这里只提取时间相关的几个字段。
func cookieValuesByLowerName(raw string) map[string]string {
	values := make(map[string]string)
	for _, part := range strings.Split(raw, ";") {
		name, value, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" {
			continue
		}
		values[name] = strings.TrimSpace(value)
	}
	return values
}

// firstInt64 依次尝试多个候选键,返回第一个能解析成正整数的值。
func firstInt64(values map[string]string, keys ...string) int64 {
	for _, key := range keys {
		raw, ok := values[key]
		if !ok {
			continue
		}
		if n, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return 0
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

package qq

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/eclipse/paho.golang/autopaho"
	"github.com/eclipse/paho.golang/paho"
	"github.com/guohuiyuan/music-lib/model"
)

const (
	qqQRShowAPI      = "https://ssl.ptlogin2.qq.com/ptqrshow"
	qqQRCheckAPI     = "https://ssl.ptlogin2.qq.com/ptqrlogin"
	qqWXQRConnectAPI = "https://open.weixin.qq.com/connect/qrconnect"
	qqWXQRCheckAPI   = "https://lp.open.weixin.qq.com/connect/l/qrconnect"
	qqWXRedirectURI  = "https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/"
	qqWXAppID        = "wx48db31d50e334801"
	qqMobileQRAPI    = "https://u.y.qq.com/cgi-bin/musicu.fcg"
	qqMobileMQTTURL  = "wss://mu.y.qq.com:443/ws/handshake"
	qqMobileQRTTL    = 15 * time.Minute
	qqMusicKeySkew   = 30 * time.Minute
)

type qqMobileQRState struct {
	Status    model.QRLoginStatus
	Message   string
	Cookie    string
	Cookies   map[string]string
	Extra     map[string]string
	ExpiresAt time.Time
}

var (
	qqMobileQRMu      sync.Mutex
	qqMobileQRPending = map[string]*qqMobileQRState{}
)

func CreateQRLogin() (*model.QRLoginSession, error) { return defaultQQ.CreateQRLogin() }

func CheckQRLogin(key string) (*model.QRLoginResult, error) { return defaultQQ.CheckQRLogin(key) }

func CreateMobileQRLogin() (*model.QRLoginSession, error) { return defaultQQ.CreateMobileQRLogin() }

func CheckMobileQRLogin(key string) (*model.QRLoginResult, error) {
	return defaultQQ.CheckMobileQRLogin(key)
}

func CreateWXQRLogin() (*model.QRLoginSession, error) { return defaultQQ.CreateWXQRLogin() }

func CheckWXQRLogin(key string) (*model.QRLoginResult, error) { return defaultQQ.CheckWXQRLogin(key) }

func RefreshLoginCookie(cookie string) (string, error) { return New(cookie).RefreshLoginCookie() }

func CookieNeedsRefresh(cookie string, now time.Time) bool {
	cookies := parseCookieString(cookie)
	if !qqCookieRefreshable(cookies) {
		return false
	}
	createdAt, ok := parseQQCookieUnix(firstNonEmptyQQ(cookies["musickeyCreateTime"], cookies["psrf_musickey_createtime"]))
	if !ok {
		return false
	}
	keyExpiresIn, ok := parseQQCookieUnix(cookies["keyExpiresIn"])
	if !ok || keyExpiresIn <= 0 {
		return false
	}
	expiresAt := time.Unix(createdAt+keyExpiresIn, 0)
	return !now.Before(expiresAt.Add(-qqMusicKeySkew))
}

func CookieRefreshable(cookie string) bool {
	return qqCookieRefreshable(parseCookieString(cookie))
}

func CreateQRLoginByType(loginType string) (*model.QRLoginSession, error) {
	return defaultQQ.CreateQRLoginByType(loginType)
}

func CheckQRLoginByType(loginType, key string) (*model.QRLoginResult, error) {
	return defaultQQ.CheckQRLoginByType(loginType, key)
}

func (q *QQ) CreateQRLoginByType(loginType string) (*model.QRLoginSession, error) {
	switch normalizeQQLoginType(loginType) {
	case "mobile":
		return q.CreateMobileQRLogin()
	case "wx":
		return q.CreateWXQRLogin()
	default:
		return q.CreateQRLogin()
	}
}

func (q *QQ) CheckQRLoginByType(loginType, key string) (*model.QRLoginResult, error) {
	switch normalizeQQLoginType(loginType) {
	case "mobile":
		return q.CheckMobileQRLogin(key)
	case "wx":
		return q.CheckWXQRLogin(key)
	default:
		return q.CheckQRLogin(key)
	}
}

func (q *QQ) RefreshLoginCookie() (string, error) {
	cookies := parseCookieString(q.cookie)
	refreshed, _, err := fetchQQRefreshLoginCookies(cookies)
	if err != nil {
		return "", err
	}
	for k, v := range refreshed {
		cookies[k] = v
	}
	q.cookie = joinCookieMap(normalizeQQMusicCookies(cookies))
	q.isVipCache = nil
	return q.cookie, nil
}

func (q *QQ) CreateQRLogin() (*model.QRLoginSession, error) {
	params := url.Values{}
	params.Set("appid", "716027609")
	params.Set("e", "2")
	params.Set("l", "M")
	params.Set("s", "3")
	params.Set("d", "72")
	params.Set("v", "4")
	params.Set("t", fmt.Sprintf("%.17f", float64(time.Now().UnixNano())/1e18))
	params.Set("daid", "383")
	params.Set("pt_3rd_aid", "100497308")

	req, err := http.NewRequest("GET", qqQRShowAPI+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	req.Header.Set("Referer", "https://xui.ptlogin2.qq.com/")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("qq qr show http status %d", resp.StatusCode)
	}
	image, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	cookies := responseCookies(resp)
	qrsig := strings.TrimSpace(cookies["qrsig"])
	if qrsig == "" {
		return nil, fmt.Errorf("qq qr show missing qrsig")
	}

	key := url.Values{}
	key.Set("qrsig", qrsig)
	key.Set("cookies", joinCookieMap(cookies))
	return &model.QRLoginSession{
		Source:    "qq",
		Key:       key.Encode(),
		ImageURL:  "data:image/png;base64," + base64StdEncode(image),
		ExpiresAt: time.Now().Add(2 * time.Minute).Unix(),
		Extra: map[string]string{
			"qrsig": qrsig,
		},
	}, nil
}

func (q *QQ) CheckQRLogin(key string) (*model.QRLoginResult, error) {
	values, err := url.ParseQuery(key)
	if err != nil {
		return nil, err
	}
	qrsig := strings.TrimSpace(values.Get("qrsig"))
	if qrsig == "" {
		return nil, fmt.Errorf("qq qr login key missing qrsig")
	}
	sessionCookies := parseCookieString(values.Get("cookies"))
	if sessionCookies["qrsig"] == "" {
		sessionCookies["qrsig"] = qrsig
	}

	params := url.Values{}
	params.Set("u1", "https://graph.qq.com/oauth2.0/login_jump")
	params.Set("ptqrtoken", strconv.Itoa(hash33(qrsig)))
	params.Set("ptredirect", "0")
	params.Set("h", "1")
	params.Set("t", "1")
	params.Set("g", "1")
	params.Set("from_ui", "1")
	params.Set("ptlang", "2052")
	params.Set("action", fmt.Sprintf("0-0-%d", time.Now().UnixMilli()))
	params.Set("js_ver", "20102616")
	params.Set("js_type", "1")
	params.Set("pt_uistyle", "40")
	params.Set("aid", "716027609")
	params.Set("daid", "383")
	params.Set("pt_3rd_aid", "100497308")
	params.Set("has_onekey", "1")

	req, err := http.NewRequest("GET", qqQRCheckAPI+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	req.Header.Set("Referer", "https://xui.ptlogin2.qq.com/")
	req.Header.Set("Cookie", joinCookieMap(sessionCookies))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	raw := string(body)
	code, message, redirectURL, uin, sigx := parseQQQRCheck(raw)
	result := &model.QRLoginResult{
		Source:  "qq",
		Key:     key,
		Status:  mapQQQRStatus(code),
		Message: message,
		Extra: map[string]string{
			"code": code,
		},
	}
	if result.Status != model.QRLoginStatusSuccess {
		return result, nil
	}

	cookies := cloneCookieMap(sessionCookies)
	for k, v := range responseCookies(resp) {
		cookies[k] = v
	}
	strongSaved := false
	if uin != "" && sigx != "" {
		strongCookies, extra, err := fetchQQConnectLoginCookies(uin, sigx, redirectURL, cookies)
		if err == nil {
			for k, v := range strongCookies {
				cookies[k] = v
			}
			for k, v := range extra {
				result.Extra[k] = v
			}
			result.Extra["credential_source"] = "qq_connect_login"
			strongSaved = true
		} else {
			result.Extra["strong_login_error"] = err.Error()
		}
	}
	if !strongSaved && redirectURL != "" {
		redirectCookies, err := fetchQQRedirectCookies(redirectURL, cookies)
		if err == nil {
			for k, v := range redirectCookies {
				cookies[k] = v
			}
			result.Extra["credential_source"] = "redirect_cookie"
		} else {
			result.Extra["redirect_error"] = err.Error()
		}
	}
	result.Cookies = normalizeQQMusicCookies(cookies)
	result.Cookie = joinCookieMap(result.Cookies)
	q.cookie = result.Cookie
	q.isVipCache = nil
	return result, nil
}

func (q *QQ) CreateMobileQRLogin() (*model.QRLoginSession, error) {
	cleanupQQMobileQRPending()
	data, err := qqMobileCreateQRCode()
	if err != nil {
		return nil, err
	}
	qrcode := strings.TrimSpace(stringFromMap(data, "qrcode"))
	qrcodeID := strings.TrimSpace(stringFromMap(data, "qrcodeID", "qrcode_id"))
	if qrcode == "" || qrcodeID == "" {
		return nil, fmt.Errorf("qq mobile qr missing qrcode/qrcodeID")
	}
	expiresIn := int64FromMap(data, "expiresIn", "expires_in")
	if expiresIn <= 0 {
		expiresIn = int64(qqMobileQRTTL / time.Second)
	}

	expiresAt := time.Now().Add(time.Duration(expiresIn) * time.Second)
	key := url.Values{}
	key.Set("type", "mobile")
	key.Set("qrcode_id", qrcodeID)
	rememberQQMobileQR(qrcodeID, &qqMobileQRState{
		Status:    model.QRLoginStatusWaiting,
		Message:   "等待扫码中",
		ExpiresAt: expiresAt,
		Extra: map[string]string{
			"login_type": "mobile",
			"stage":      "created",
		},
	})
	go q.waitQQMobileQRLogin(qrcodeID, expiresAt)

	return &model.QRLoginSession{
		Source:    "qq",
		Key:       key.Encode(),
		ImageURL:  qrcode,
		ExpiresAt: expiresAt.Unix(),
		Extra: map[string]string{
			"login_type": "mobile",
			"qrcode_id":  qrcodeID,
		},
	}, nil
}

func (q *QQ) CheckMobileQRLogin(key string) (*model.QRLoginResult, error) {
	values, err := url.ParseQuery(key)
	if err != nil {
		return nil, err
	}
	qrcodeID := strings.TrimSpace(values.Get("qrcode_id"))
	if qrcodeID == "" {
		return nil, fmt.Errorf("qq mobile qr login key missing qrcode_id")
	}
	state, ok := getQQMobileQR(qrcodeID)
	if !ok {
		return &model.QRLoginResult{
			Source:  "qq",
			Key:     key,
			Status:  model.QRLoginStatusExpired,
			Message: "二维码已过期,请刷新",
			Extra: map[string]string{
				"login_type": "mobile",
			},
		}, nil
	}
	if time.Now().After(state.ExpiresAt) && state.Status != model.QRLoginStatusSuccess {
		state.Status = model.QRLoginStatusExpired
		state.Message = "二维码已过期,请刷新"
		updateQQMobileQR(qrcodeID, state)
	}
	if state.Status == model.QRLoginStatusSuccess {
		q.cookie = state.Cookie
		q.isVipCache = nil
	}
	return &model.QRLoginResult{
		Source:  "qq",
		Key:     key,
		Status:  state.Status,
		Message: state.Message,
		Cookie:  state.Cookie,
		Cookies: cloneCookieMap(state.Cookies),
		Extra:   cloneCookieMap(state.Extra),
	}, nil
}

func (q *QQ) CreateWXQRLogin() (*model.QRLoginSession, error) {
	state := fmt.Sprintf("music-lib-%d", time.Now().UnixNano())
	params := url.Values{}
	params.Set("appid", qqWXAppID)
	params.Set("redirect_uri", qqWXRedirectURI)
	params.Set("response_type", "code")
	params.Set("scope", "snsapi_login")
	params.Set("state", state)
	params.Set("href", "https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect")
	loginURL := qqWXQRConnectAPI + "?" + params.Encode()

	req, err := http.NewRequest("GET", loginURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	req.Header.Set("Referer", "https://y.qq.com/")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("qq wx qr connect http status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	uuid := parseQQWXQRUUID(string(body))
	if uuid == "" {
		return nil, fmt.Errorf("qq wx qr connect missing uuid")
	}

	key := url.Values{}
	key.Set("type", "wx")
	key.Set("uuid", uuid)
	key.Set("state", state)
	return &model.QRLoginSession{
		Source:    "qq",
		Key:       key.Encode(),
		URL:       loginURL,
		ImageURL:  "https://open.weixin.qq.com/connect/qrcode/" + url.PathEscape(uuid),
		ExpiresAt: time.Now().Add(5 * time.Minute).Unix(),
		Extra: map[string]string{
			"login_type": "wx",
			"uuid":       uuid,
		},
	}, nil
}

func (q *QQ) CheckWXQRLogin(key string) (*model.QRLoginResult, error) {
	values, err := url.ParseQuery(key)
	if err != nil {
		return nil, err
	}
	uuid := strings.TrimSpace(values.Get("uuid"))
	state := strings.TrimSpace(values.Get("state"))
	if uuid == "" {
		return nil, fmt.Errorf("qq wx qr login key missing uuid")
	}
	if state == "" {
		state = "STATE"
	}

	params := url.Values{}
	params.Set("uuid", uuid)
	params.Set("_", strconv.FormatInt(time.Now().UnixMilli(), 10))
	req, err := http.NewRequest("GET", qqWXQRCheckAPI+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	req.Header.Set("Referer", qqWXQRConnectAPI)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	raw := string(body)
	code, wxCode := parseQQWXQRCheck(raw)
	result := &model.QRLoginResult{
		Source:  "qq",
		Key:     key,
		Status:  mapQQWXQRStatus(code),
		Message: qqWXQRMessage(code, raw),
		Extra: map[string]string{
			"code":       code,
			"login_type": "wx",
		},
	}
	if result.Status != model.QRLoginStatusSuccess {
		return result, nil
	}
	if wxCode == "" {
		result.Status = model.QRLoginStatusFailed
		result.Message = "wechat auth code missing"
		return result, nil
	}

	cookies, extra, err := fetchQQWXLoginCookies(wxCode)
	if err != nil {
		result.Status = model.QRLoginStatusFailed
		result.Message = err.Error()
		return result, nil
	}
	for k, v := range extra {
		result.Extra[k] = v
	}
	result.Extra["state"] = state
	result.Cookies = normalizeQQMusicCookies(cookies)
	result.Cookie = joinCookieMap(result.Cookies)
	q.cookie = result.Cookie
	q.isVipCache = nil
	return result, nil
}

func mapQQQRStatus(code string) model.QRLoginStatus {
	switch code {
	case "0":
		return model.QRLoginStatusSuccess
	case "65":
		return model.QRLoginStatusExpired
	case "66":
		return model.QRLoginStatusWaiting
	case "67":
		return model.QRLoginStatusScanned
	default:
		return model.QRLoginStatusFailed
	}
}

func parseQQQRCheck(raw string) (code, message, redirectURL, uin, sigx string) {
	re := regexp.MustCompile(`'([^']*)'`)
	matches := re.FindAllStringSubmatch(raw, -1)
	if len(matches) >= 5 {
		redirectURL = matches[2][1]
		// Keep ptsigx byte-for-byte from the raw URL. url.Parse(...).Query()
		// decodes '+' as a space, which breaks QQ check_sig for some tokens.
		if m := regexp.MustCompile(`(?:\?|&)uin=([^&]+)&service`).FindStringSubmatch(redirectURL); len(m) > 1 {
			uin = strings.TrimSpace(m[1])
		}
		if m := regexp.MustCompile(`(?:\?|&)ptsigx=([^&]+)&s_url`).FindStringSubmatch(redirectURL); len(m) > 1 {
			sigx = strings.TrimSpace(m[1])
		}
		return matches[0][1], matches[4][1], redirectURL, uin, sigx
	}
	return "", raw, "", "", ""
}

func mapQQWXQRStatus(code string) model.QRLoginStatus {
	switch code {
	case "405":
		return model.QRLoginStatusSuccess
	case "402":
		return model.QRLoginStatusExpired
	case "404":
		return model.QRLoginStatusScanned
	case "408":
		return model.QRLoginStatusWaiting
	default:
		return model.QRLoginStatusFailed
	}
}

func qqWXQRMessage(code, raw string) string {
	switch code {
	case "405":
		return "登录成功"
	case "402":
		return "二维码已过期"
	case "404":
		return "已扫码，请在微信中确认"
	case "408":
		return "等待扫码中"
	default:
		return strings.TrimSpace(raw)
	}
}

func parseQQWXQRUUID(raw string) string {
	patterns := []string{
		`connect/l/qrconnect\?uuid=([A-Za-z0-9_-]+)`,
		`window\.QRLogin\.uuid\s*=\s*"([^"]+)"`,
		`/connect/qrcode/([A-Za-z0-9_-]+)`,
	}
	for _, pattern := range patterns {
		matches := regexp.MustCompile(pattern).FindStringSubmatch(raw)
		if len(matches) > 1 && strings.TrimSpace(matches[1]) != "" {
			return strings.TrimSpace(matches[1])
		}
	}
	return ""
}

func parseQQWXQRCheck(raw string) (code, wxCode string) {
	if matches := regexp.MustCompile(`wx_errcode\s*=\s*'?([0-9]+)'?`).FindStringSubmatch(raw); len(matches) > 1 {
		code = strings.TrimSpace(matches[1])
	}
	if matches := regexp.MustCompile(`wx_code\s*=\s*["']([^"']*)["']`).FindStringSubmatch(raw); len(matches) > 1 {
		wxCode = strings.TrimSpace(matches[1])
	}
	return code, wxCode
}

func fetchQQConnectLoginCookies(uin, sigx, redirectURL string, baseCookies map[string]string) (map[string]string, map[string]string, error) {
	checkCookies, err := fetchQQCheckSigCookies(uin, sigx, redirectURL, baseCookies)
	if err != nil {
		return nil, nil, err
	}
	code, authCookies, tokenName, err := fetchQQAuthorizeCode(checkCookies)
	if err != nil {
		return nil, nil, err
	}
	for k, v := range authCookies {
		checkCookies[k] = v
	}

	loginCookies, extra, err := fetchQQConnectLoginServerCookies(code)
	if err != nil {
		return nil, nil, err
	}
	for k, v := range loginCookies {
		checkCookies[k] = v
	}
	extra["login_type"] = "qq"
	extra["authorize_token"] = tokenName
	return normalizeQQMusicCookies(checkCookies), extra, nil
}

func fetchQQCheckSigCookies(uin, sigx, redirectURL string, baseCookies map[string]string) (map[string]string, error) {
	redirectURL = strings.TrimSpace(redirectURL)
	if redirectURL != "" {
		return fetchQQCheckSigCookiesFromURL(redirectURL, baseCookies)
	}

	params := url.Values{}
	params.Set("uin", uin)
	params.Set("pttype", "1")
	params.Set("service", "ptqrlogin")
	params.Set("nodirect", "0")
	params.Set("ptsigx", sigx)
	params.Set("s_url", "https://graph.qq.com/oauth2.0/login_jump")
	params.Set("ptlang", "2052")
	params.Set("ptredirect", "100")
	params.Set("aid", "716027609")
	params.Set("daid", "383")
	params.Set("j_later", "0")
	params.Set("low_login_hour", "0")
	params.Set("regmaster", "0")
	params.Set("pt_login_type", "3")
	params.Set("pt_aid", "0")
	params.Set("pt_aaid", "16")
	params.Set("pt_light", "0")
	params.Set("pt_3rd_aid", "100497308")

	return fetchQQCheckSigCookiesFromURL("https://ssl.ptlogin2.graph.qq.com/check_sig?"+params.Encode(), baseCookies)
}

func fetchQQCheckSigCookiesFromURL(initialURL string, baseCookies map[string]string) (map[string]string, error) {
	client := &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	cookies := cloneCookieMap(baseCookies)
	currentURL := strings.TrimSpace(initialURL)
	referer := "https://xui.ptlogin2.qq.com/"
	lastStatus := 0
	lastLocation := ""
	seenFallbackAuth := false

	for i := 0; i < 5 && currentURL != ""; i++ {
		req, err := http.NewRequest("GET", currentURL, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
		req.Header.Set("Referer", referer)
		if len(cookies) > 0 {
			req.Header.Set("Cookie", joinCookieMap(cookies))
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		for k, v := range responseCookies(resp) {
			cookies[k] = v
		}
		lastStatus = resp.StatusCode
		location := strings.TrimSpace(resp.Header.Get("Location"))
		if location != "" {
			lastLocation = location
		}
		resp.Body.Close()

		if firstNonEmptyQQ(cookies["p_skey"], cookies["skey"]) != "" {
			return cookies, nil
		}
		if hasQQConnectAuthCookies(cookies) {
			seenFallbackAuth = true
		}
		if location == "" || resp.StatusCode < 300 || resp.StatusCode >= 400 {
			break
		}
		nextURL, err := url.Parse(location)
		if err != nil {
			return nil, err
		}
		if !nextURL.IsAbs() {
			baseURL, err := url.Parse(currentURL)
			if err != nil {
				return nil, err
			}
			nextURL = baseURL.ResolveReference(nextURL)
		}
		referer = currentURL
		currentURL = nextURL.String()
	}

	if seenFallbackAuth || hasQQConnectAuthCookies(cookies) {
		return cookies, nil
	}
	return nil, fmt.Errorf("qq connect check_sig did not return auth cookies; status=%d location=%s cookies=%s", lastStatus, safeLocation(lastLocation), strings.Join(cookieNames(cookies), ","))
}

type qqAuthorizeTokenCandidate struct {
	name  string
	token string
}

func qqAuthorizeTokenCandidates(cookies map[string]string) []qqAuthorizeTokenCandidate {
	seen := map[string]bool{}
	candidates := []qqAuthorizeTokenCandidate{}
	add := func(name, token string) {
		name = strings.TrimSpace(name)
		token = strings.TrimSpace(token)
		key := name + "\x00" + token
		if name == "" || seen[key] {
			return
		}
		seen[key] = true
		candidates = append(candidates, qqAuthorizeTokenCandidate{name: name, token: token})
	}

	add("p_skey", cookies["p_skey"])
	add("skey", cookies["skey"])
	add("superkey", cookies["superkey"])
	add("supertoken", cookies["supertoken"])
	add("pt_oauth_token", cookies["pt_oauth_token"])
	add("default_5381", "")
	return candidates
}

func hasQQConnectAuthCookies(cookies map[string]string) bool {
	for _, candidate := range qqAuthorizeTokenCandidates(cookies) {
		if candidate.name != "default_5381" && candidate.token != "" {
			return true
		}
	}
	return false
}

func fetchQQAuthorizeCode(cookies map[string]string) (string, map[string]string, string, error) {
	var lastErr error
	tried := []string{}
	failures := []string{}
	for _, candidate := range qqAuthorizeTokenCandidates(cookies) {
		if candidate.name != "default_5381" && candidate.token == "" {
			continue
		}
		tried = append(tried, candidate.name)
		code, authCookies, err := fetchQQAuthorizeCodeWithToken(cookies, candidate)
		if err == nil {
			return code, authCookies, candidate.name, nil
		}
		lastErr = err
		failures = append(failures, err.Error())
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no usable token candidates")
	}
	return "", nil, "", fmt.Errorf("qq connect authorize failed; tried=%s; failures=[%s]; last=%v", strings.Join(tried, ","), strings.Join(failures, " | "), lastErr)
}

func fetchQQAuthorizeCodeWithToken(cookies map[string]string, candidate qqAuthorizeTokenCandidate) (string, map[string]string, error) {
	form := url.Values{}
	form.Set("response_type", "code")
	form.Set("client_id", "100497308")
	form.Set("redirect_uri", "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/")
	form.Set("scope", "get_user_info,get_app_friends")
	form.Set("state", "state")
	form.Set("switch", "")
	form.Set("from_ptlogin", "1")
	form.Set("src", "1")
	form.Set("update_auth", "1")
	form.Set("openapi", "1010_1030")
	form.Set("g_tk", strconv.Itoa(hash33WithSeed(candidate.token, 5381)))
	form.Set("auth_time", strconv.FormatInt(time.Now().Unix()*1000, 10))
	form.Set("ui", strconv.FormatInt(time.Now().UnixNano(), 10))

	client := &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequest("POST", "https://graph.qq.com/oauth2.0/authorize", strings.NewReader(form.Encode()))
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	req.Header.Set("Referer", "https://graph.qq.com/oauth2.0/show?which=Login&display=pc")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Cookie", joinCookieMap(cookies))
	resp, err := client.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()

	authCookies := responseCookies(resp)
	location := strings.TrimSpace(resp.Header.Get("Location"))
	if location == "" {
		return "", authCookies, fmt.Errorf("qq connect authorize missing redirect location; token=%s status=%d cookies=%s", candidate.name, resp.StatusCode, strings.Join(cookieNames(authCookies), ","))
	}
	parsed, err := url.Parse(location)
	if err != nil {
		return "", authCookies, err
	}
	code := strings.TrimSpace(parsed.Query().Get("code"))
	if code == "" {
		return "", authCookies, fmt.Errorf("qq connect authorize missing code; token=%s status=%d location=%s cookies=%s", candidate.name, resp.StatusCode, safeLocation(location), strings.Join(cookieNames(authCookies), ","))
	}
	return code, authCookies, nil
}

func fetchQQConnectLoginServerCookies(code string) (map[string]string, map[string]string, error) {
	payload, err := json.Marshal(map[string]interface{}{
		"comm": map[string]interface{}{
			"tmeAppID":     "qqmusic",
			"tmeLoginType": 2,
			"g_tk":         5381,
			"platform":     "yqq",
			"ct":           24,
			"cv":           0,
		},
		"req": map[string]interface{}{
			"module": "QQConnectLogin.LoginServer",
			"method": "QQLogin",
			"param": map[string]string{
				"code": code,
			},
		},
	})
	if err != nil {
		return nil, nil, err
	}

	endpoints := []string{
		"https://u.y.qq.com/cgi-bin/musicu.fcg",
		"https://szu.y.qq.com/cgi-bin/musicu.fcg",
		"https://shu.y.qq.com/cgi-bin/musicu.fcg",
	}
	var lastErr error
	for _, apiURL := range endpoints {
		req, err := http.NewRequest("POST", apiURL, strings.NewReader(string(payload)))
		if err != nil {
			return nil, nil, err
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
		req.Header.Set("Referer", "https://y.qq.com/")
		req.Header.Set("Origin", "https://y.qq.com")
		req.Header.Set("Accept", "*/*")
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, readErr := io.ReadAll(resp.Body)
		cookies := responseCookies(resp)
		resp.Body.Close()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("qq connect login http status %d", resp.StatusCode)
			continue
		}

		var parsed struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Msg     string `json:"msg"`
			Req     struct {
				Code    int                    `json:"code"`
				Message string                 `json:"message"`
				Msg     string                 `json:"msg"`
				Data    map[string]interface{} `json:"data"`
			} `json:"req"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			lastErr = fmt.Errorf("qq connect login json parse error: %w", err)
			continue
		}
		if parsed.Code != 0 || parsed.Req.Code != 0 {
			msg := firstNonEmptyQQ(parsed.Req.Message, parsed.Req.Msg, parsed.Message, parsed.Msg)
			lastErr = fmt.Errorf("qq connect login api error: %s (code %d, req code %d)", msg, parsed.Code, parsed.Req.Code)
			continue
		}

		for k, v := range qqLoginDataCookies(parsed.Req.Data) {
			if cookies[k] == "" {
				cookies[k] = v
			}
		}
		return cookies, map[string]string{"endpoint": apiURL}, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("qq connect login failed")
	}
	return nil, nil, lastErr
}

func fetchQQRefreshLoginCookies(cookies map[string]string) (map[string]string, map[string]string, error) {
	if !qqCookieRefreshable(cookies) {
		return nil, nil, fmt.Errorf("qq cookie is not refreshable")
	}
	musicID := firstNonEmptyQQ(cookies["musicid"], cookies["qqmusic_uin"], cookies["str_musicid"], cookies["uin"])
	musicKey := firstNonEmptyQQ(cookies["musickey"], cookies["qqmusic_key"], cookies["qm_keyst"])
	refreshKey := strings.TrimSpace(cookies["refresh_key"])
	refreshToken := strings.TrimSpace(cookies["refresh_token"])

	musicIDValue := interface{}(musicID)
	if parsed, err := strconv.ParseInt(musicID, 10, 64); err == nil {
		musicIDValue = parsed
	}
	param := map[string]interface{}{
		"musicid":       musicIDValue,
		"musickey":      musicKey,
		"refresh_key":   refreshKey,
		"refresh_token": refreshToken,
	}
	if openID := strings.TrimSpace(cookies["openid"]); openID != "" {
		param["openid"] = openID
	}
	if accessToken := strings.TrimSpace(firstNonEmptyQQ(cookies["access_token"], cookies["wxaccess_token"])); accessToken != "" {
		param["access_token"] = accessToken
	}

	payload, err := json.Marshal(map[string]interface{}{
		"comm": map[string]interface{}{
			"tmeAppID":     "qqmusic",
			"tmeLoginType": 2,
			"g_tk":         5381,
			"platform":     "yqq",
			"ct":           24,
			"cv":           0,
		},
		"req": map[string]interface{}{
			"module": "music.login.LoginServer",
			"method": "Login",
			"param":  param,
		},
	})
	if err != nil {
		return nil, nil, err
	}

	endpoints := []string{
		"https://u.y.qq.com/cgi-bin/musicu.fcg",
		"https://szu.y.qq.com/cgi-bin/musicu.fcg",
		"https://shu.y.qq.com/cgi-bin/musicu.fcg",
	}
	var lastErr error
	for _, apiURL := range endpoints {
		req, err := http.NewRequest("POST", apiURL, strings.NewReader(string(payload)))
		if err != nil {
			return nil, nil, err
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
		req.Header.Set("Referer", "https://y.qq.com/")
		req.Header.Set("Origin", "https://y.qq.com")
		req.Header.Set("Accept", "*/*")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Cookie", joinCookieMap(cookies))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, readErr := io.ReadAll(resp.Body)
		responseCookieMap := responseCookies(resp)
		resp.Body.Close()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("qq refresh login http status %d", resp.StatusCode)
			continue
		}

		var parsed struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Msg     string `json:"msg"`
			Req     struct {
				Code    int                    `json:"code"`
				Message string                 `json:"message"`
				Msg     string                 `json:"msg"`
				Data    map[string]interface{} `json:"data"`
			} `json:"req"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			lastErr = fmt.Errorf("qq refresh login json parse error: %w", err)
			continue
		}
		if parsed.Code != 0 || parsed.Req.Code != 0 {
			msg := firstNonEmptyQQ(parsed.Req.Message, parsed.Req.Msg, parsed.Message, parsed.Msg)
			lastErr = fmt.Errorf("qq refresh login api error: %s (code %d, req code %d)", msg, parsed.Code, parsed.Req.Code)
			continue
		}

		loginCookies := qqLoginDataCookies(parsed.Req.Data)
		if len(loginCookies) == 0 || firstNonEmptyQQ(loginCookies["musickey"], loginCookies["qqmusic_key"], loginCookies["qm_keyst"]) == "" {
			lastErr = fmt.Errorf("qq refresh login returned no musickey; keys=%s", strings.Join(mapKeys(parsed.Req.Data), ","))
			continue
		}
		for k, v := range responseCookieMap {
			if loginCookies[k] == "" {
				loginCookies[k] = v
			}
		}
		return normalizeQQMusicCookies(loginCookies), map[string]string{"endpoint": apiURL}, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("qq refresh login failed")
	}
	return nil, nil, lastErr
}

func qqMobileCreateQRCode() (map[string]interface{}, error) {
	return qqMobileMusicuRequest(
		"music.login.LoginServer",
		"CreateQRCode",
		map[string]interface{}{
			"tmeAppID": "qqmusic",
			"ct":       11,
			"cv":       14090008,
		},
		map[string]interface{}{
			"ct": 23,
			"cv": 0,
		},
	)
}

func (q *QQ) waitQQMobileQRLogin(qrcodeID string, expiresAt time.Time) {
	ctx, cancel := context.WithDeadline(context.Background(), expiresAt)
	defer cancel()

	messages := make(chan *paho.Publish, 8)
	brokerURL, err := url.Parse(qqMobileMQTTURL)
	if err != nil {
		failQQMobileQR(qrcodeID, err)
		return
	}
	clientID := fmt.Sprintf("%d%d", time.Now().UnixMilli(), time.Now().Nanosecond()%9000+1000)
	cfg := autopaho.ClientConfig{
		ServerUrls:                    []*url.URL{brokerURL},
		TlsCfg:                        &tls.Config{MinVersion: tls.VersionTLS12},
		KeepAlive:                     45,
		CleanStartOnInitialConnection: true,
		ConnectTimeout:                20 * time.Second,
		WebSocketCfg: &autopaho.WebSocketConfig{
			Header: func(_ *url.URL, _ *tls.Config) http.Header {
				return http.Header{
					"Origin":     []string{"https://y.qq.com"},
					"Referer":    []string{"https://y.qq.com/"},
					"User-Agent": []string{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"},
				}
			},
		},
		ConnectPacketBuilder: func(connect *paho.Connect, _ *url.URL) (*paho.Connect, error) {
			if connect.Properties == nil {
				connect.Properties = &paho.ConnectProperties{}
			}
			connect.Properties.AuthMethod = "pass"
			connect.Properties.User = paho.UserProperties{
				{Key: "tmeAppID", Value: "qqmusic"},
				{Key: "business", Value: "management"},
				{Key: "hashTag", Value: qrcodeID},
				{Key: "clientTag", Value: "management.user"},
				{Key: "userID", Value: qrcodeID},
			}
			return connect, nil
		},
		ClientConfig: paho.ClientConfig{
			ClientID: clientID,
			OnPublishReceived: []func(paho.PublishReceived) (bool, error){
				func(pr paho.PublishReceived) (bool, error) {
					if pr.Packet == nil {
						return false, nil
					}
					select {
					case messages <- pr.Packet:
					default:
					}
					return true, nil
				},
			},
		},
	}
	cm, err := autopaho.NewConnection(ctx, cfg)
	if err != nil {
		failQQMobileQR(qrcodeID, err)
		return
	}
	defer cm.Disconnect(context.Background())
	connectCtx, connectCancel := context.WithTimeout(ctx, 25*time.Second)
	err = cm.AwaitConnection(connectCtx)
	connectCancel()
	if err != nil {
		failQQMobileQRWithExtra(qrcodeID, err, map[string]string{"stage": "mqtt_connect"})
		return
	}
	setQQMobileQRExtra(qrcodeID, map[string]string{"stage": "mqtt_connected"})

	topic := "management.qrcode_login/" + qrcodeID
	subCtx, subCancel := context.WithTimeout(ctx, 20*time.Second)
	_, err = cm.Subscribe(subCtx, &paho.Subscribe{
		Subscriptions: []paho.SubscribeOptions{{Topic: topic, QoS: 0}},
		Properties: &paho.SubscribeProperties{
			User: paho.UserProperties{
				{Key: "authorization", Value: "tmelogin"},
				{Key: "pubsub", Value: "unicast"},
			},
		},
	})
	subCancel()
	if err != nil {
		failQQMobileQRWithExtra(qrcodeID, err, map[string]string{"stage": "mqtt_subscribe"})
		return
	}
	setQQMobileQRExtra(qrcodeID, map[string]string{"stage": "mqtt_subscribed", "mqtt_topic": "management.qrcode_login"})

	for {
		select {
		case <-ctx.Done():
			expireQQMobileQR(qrcodeID)
			return
		case packet := <-messages:
			done := q.handleQQMobileQRMessage(qrcodeID, packet)
			if done {
				return
			}
		}
	}
}

func (q *QQ) handleQQMobileQRMessage(qrcodeID string, packet *paho.Publish) bool {
	payload, payloadErr := qqMobilePayloadMap(packet)
	messageType := qqMobileMessageType(packet, payload)
	messageExtra := qqMobileMessageExtra(packet, payload)
	if messageType != "" {
		messageExtra["last_event"] = messageType
	}
	if payloadErr != nil {
		messageExtra["payload_error"] = payloadErr.Error()
	}
	setQQMobileQRExtra(qrcodeID, messageExtra)

	switch messageType {
	case "scanned":
		markQQMobileQRScanned(qrcodeID)
	case "canceled":
		setQQMobileQRFailedWithExtra(qrcodeID, "用户取消登录", messageExtra)
		return true
	case "timeout":
		expireQQMobileQR(qrcodeID)
		return true
	case "loginFailed":
		setQQMobileQRFailedWithExtra(qrcodeID, firstNonEmptyQQ(qqMobilePayloadText(payload, "message", "msg", "error", "err_msg"), "登录失败"), messageExtra)
		return true
	case "cookies":
		if payloadErr != nil {
			setQQMobileQRFailedWithExtra(qrcodeID, "登录消息解析失败: "+payloadErr.Error(), messageExtra)
			return true
		}
		uin := qqMobileCookieValue(payload, "qqmusic_uin", "musicid", "musicId", "uin", "userid", "user_id")
		token := qqMobileCookieValue(payload, "qqmusic_key", "musickey", "qm_keyst", "music_key", "strMusicKey", "token")
		if uin == "" || token == "" {
			setQQMobileQRFailedWithExtra(qrcodeID, "登录消息缺少 QQ 音乐强凭证字段", messageExtra)
			return true
		}
		cookies, extra, err := qqMobileLoginWithQRCode(qrcodeID, uin, token)
		if err != nil {
			failQQMobileQRWithExtra(qrcodeID, err, messageExtra)
			return true
		}
		completeQQMobileQR(qrcodeID, cookies, extra)
		q.cookie = joinCookieMap(cookies)
		q.isVipCache = nil
		return true
	}
	return false
}

func qqMobileLoginWithQRCode(qrcodeID, uin, token string) (map[string]string, map[string]string, error) {
	musicIDValue := interface{}(uin)
	if parsed, err := strconv.ParseInt(uin, 10, 64); err == nil {
		musicIDValue = parsed
	}
	data, err := qqMobileMusicuRequest(
		"music.login.LoginServer",
		"Login",
		map[string]interface{}{
			"musicid":  musicIDValue,
			"qrCodeID": qrcodeID,
			"token":    token,
		},
		map[string]interface{}{
			"tmeLoginType": 6,
		},
	)
	if err != nil {
		return nil, nil, err
	}
	credential, err := qqMobileCredentialData(data)
	if err != nil {
		return nil, nil, err
	}
	cookies := qqLoginDataCookies(credential)
	if len(cookies) == 0 || firstNonEmptyQQ(cookies["musickey"], cookies["qqmusic_key"], cookies["qm_keyst"]) == "" {
		return nil, nil, fmt.Errorf("qq mobile login returned no musickey; keys=%s", strings.Join(mapKeys(credential), ","))
	}
	extra := map[string]string{
		"login_type":        "mobile",
		"credential_source": "qq_mobile_qr",
	}
	return normalizeQQMusicCookies(cookies), extra, nil
}

func qqMobileMusicuRequest(module, method string, param, comm map[string]interface{}) (map[string]interface{}, error) {
	finalComm := qqMobileBaseComm()
	for k, v := range comm {
		finalComm[k] = v
	}
	payload := map[string]interface{}{
		"comm": finalComm,
		"req_0": map[string]interface{}{
			"module": module,
			"method": method,
			"param":  param,
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest("POST", qqMobileQRAPI, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "QQMusic 14090008(android 10)")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("qq mobile musicu http status %d", resp.StatusCode)
	}
	var parsed struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Msg     string `json:"msg"`
		Req0    struct {
			Code    int                    `json:"code"`
			Message string                 `json:"message"`
			Msg     string                 `json:"msg"`
			Data    map[string]interface{} `json:"data"`
		} `json:"req_0"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, fmt.Errorf("qq mobile musicu json parse error: %w", err)
	}
	if parsed.Code != 0 || parsed.Req0.Code != 0 {
		msg := firstNonEmptyQQ(parsed.Req0.Message, parsed.Req0.Msg, parsed.Message, parsed.Msg)
		return nil, fmt.Errorf("qq mobile musicu api error: %s (code %d, req code %d)", msg, parsed.Code, parsed.Req0.Code)
	}
	return parsed.Req0.Data, nil
}

func qqMobileBaseComm() map[string]interface{} {
	guid := "0123456789abcdef0123456789abcdef"
	return map[string]interface{}{
		"ct":             11,
		"cv":             14090008,
		"v":              14090008,
		"chid":           "10003505",
		"tmeAppID":       "qqmusic",
		"QIMEI":          "",
		"QIMEI36":        "",
		"OpenUDID":       guid,
		"udid":           guid,
		"OpenUDID2":      guid,
		"aid":            "0123456789abcdef",
		"os_ver":         "10",
		"phonetype":      "MI 6",
		"devicelevel":    "29",
		"newdevicelevel": "29",
		"rom":            "xiaomi/iarim/sagit:10/eomam.200122.001/1234567:user/release-keys",
	}
}

func fetchQQWXLoginCookies(wxCode string) (map[string]string, map[string]string, error) {
	payload, err := json.Marshal(map[string]interface{}{
		"comm": map[string]interface{}{
			"tmeAppID":     "qqmusic",
			"tmeLoginType": "1",
			"g_tk":         5381,
			"platform":     "yqq",
			"ct":           24,
			"cv":           0,
		},
		"req": map[string]interface{}{
			"module": "music.login.LoginServer",
			"method": "Login",
			"param": map[string]string{
				"strAppid": qqWXAppID,
				"code":     wxCode,
			},
		},
	})
	if err != nil {
		return nil, nil, err
	}

	endpoints := []string{
		"https://u.y.qq.com/cgi-bin/musicu.fcg",
		"https://szu.y.qq.com/cgi-bin/musicu.fcg",
		"https://shu.y.qq.com/cgi-bin/musicu.fcg",
	}
	var lastErr error
	for _, apiURL := range endpoints {
		req, err := http.NewRequest("POST", apiURL, strings.NewReader(string(payload)))
		if err != nil {
			return nil, nil, err
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
		req.Header.Set("Referer", qqWXRedirectURI)
		req.Header.Set("Origin", "https://y.qq.com")
		req.Header.Set("Accept", "*/*")
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Cookie", "login_type=2")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, readErr := io.ReadAll(resp.Body)
		cookies := responseCookies(resp)
		resp.Body.Close()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("qq wx login http status %d", resp.StatusCode)
			continue
		}

		var parsed struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Msg     string `json:"msg"`
			Req     struct {
				Code    int                    `json:"code"`
				Message string                 `json:"message"`
				Msg     string                 `json:"msg"`
				Data    map[string]interface{} `json:"data"`
			} `json:"req"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			lastErr = fmt.Errorf("qq wx login json parse error: %w", err)
			continue
		}
		if parsed.Code != 0 || parsed.Req.Code != 0 {
			msg := firstNonEmptyQQ(parsed.Req.Message, parsed.Req.Msg, parsed.Message, parsed.Msg)
			lastErr = fmt.Errorf("qq wx login api error: %s (code %d, req code %d)", msg, parsed.Code, parsed.Req.Code)
			continue
		}

		for k, v := range qqLoginDataCookies(parsed.Req.Data) {
			if cookies[k] == "" {
				cookies[k] = v
			}
		}
		extra := map[string]string{
			"endpoint": apiURL,
		}
		return cookies, extra, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("qq wx login failed")
	}
	return nil, nil, lastErr
}

func qqLoginDataCookies(data map[string]interface{}) map[string]string {
	result := map[string]string{}
	value := func(keys ...string) string {
		for _, key := range keys {
			switch v := data[key].(type) {
			case string:
				if strings.TrimSpace(v) != "" {
					return strings.TrimSpace(v)
				}
			case float64:
				if v > 0 {
					return strconv.FormatInt(int64(v), 10)
				}
			}
		}
		return ""
	}

	if musicID := value("musicid", "musicId", "userid", "user_id", "uin"); musicID != "" {
		result["musicid"] = musicID
		result["qqmusic_uin"] = musicID
	}
	if musicKey := value("musickey", "music_key", "qqmusic_key", "qm_keyst", "strMusicKey"); musicKey != "" {
		result["musickey"] = musicKey
		result["qqmusic_key"] = musicKey
		result["qm_keyst"] = musicKey
	}
	if refreshKey := value("refresh_key", "refreshKey"); refreshKey != "" {
		result["refresh_key"] = refreshKey
	}
	if refreshToken := value("refresh_token", "refreshToken"); refreshToken != "" {
		result["refresh_token"] = refreshToken
	}
	if openID := value("openid", "openId", "wxopenid", "strOpenid"); openID != "" {
		result["openid"] = openID
		result["wxopenid"] = openID
	}
	if unionID := value("unionid", "unionId", "wxunionid", "strUnionid"); unionID != "" {
		result["unionid"] = unionID
		result["wxunionid"] = unionID
	}
	if accessToken := value("access_token", "accessToken", "wxaccess_token"); accessToken != "" {
		result["access_token"] = accessToken
		result["wxaccess_token"] = accessToken
	}
	if expiredAt := value("expired_at", "expiredAt", "expired_in", "expiredIn"); expiredAt != "" {
		result["expired_at"] = expiredAt
	}
	if strMusicID := value("str_musicid", "strMusicid", "strMusicID"); strMusicID != "" {
		result["str_musicid"] = strMusicID
	}
	if musickeyCreateTime := value("musickeyCreateTime", "musickey_create_time", "psrf_musickey_createtime"); musickeyCreateTime != "" {
		result["musickeyCreateTime"] = musickeyCreateTime
		result["psrf_musickey_createtime"] = musickeyCreateTime
	}
	if keyExpiresIn := value("keyExpiresIn", "key_expires_in"); keyExpiresIn != "" {
		result["keyExpiresIn"] = keyExpiresIn
	}
	if encryptUin := value("encryptUin", "encrypt_uin", "euin"); encryptUin != "" {
		result["encryptUin"] = encryptUin
		result["euin"] = encryptUin
	}
	if loginType := value("loginType", "login_type", "tmeLoginType"); loginType != "" {
		result["loginType"] = loginType
		result["tmeLoginType"] = loginType
	}
	return result
}

func fetchQQRedirectCookies(redirectURL string, cookies map[string]string) (map[string]string, error) {
	client := &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	currentURL := strings.TrimSpace(redirectURL)
	collected := make(map[string]string, len(cookies)+8)
	for k, v := range cookies {
		collected[k] = v
	}
	referer := "https://y.qq.com/"

	for i := 0; i < 8 && currentURL != ""; i++ {
		req, err := http.NewRequest("GET", currentURL, nil)
		if err != nil {
			return collected, err
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
		req.Header.Set("Referer", referer)
		req.Header.Set("Cookie", joinCookieMap(collected))
		resp, err := client.Do(req)
		if err != nil {
			return collected, err
		}

		for k, v := range responseCookies(resp) {
			collected[k] = v
		}

		location := strings.TrimSpace(resp.Header.Get("Location"))
		resp.Body.Close()
		if location == "" || resp.StatusCode < 300 || resp.StatusCode >= 400 {
			break
		}
		nextURL, err := url.Parse(location)
		if err != nil {
			return collected, err
		}
		if !nextURL.IsAbs() {
			baseURL, err := url.Parse(currentURL)
			if err != nil {
				return collected, err
			}
			nextURL = baseURL.ResolveReference(nextURL)
		}
		referer = currentURL
		currentURL = nextURL.String()
	}

	return collected, nil
}

func rememberQQMobileQR(qrcodeID string, state *qqMobileQRState) {
	qqMobileQRMu.Lock()
	defer qqMobileQRMu.Unlock()
	qqMobileQRPending[qrcodeID] = state
}

func getQQMobileQR(qrcodeID string) (*qqMobileQRState, bool) {
	qqMobileQRMu.Lock()
	defer qqMobileQRMu.Unlock()
	state, ok := qqMobileQRPending[qrcodeID]
	if !ok || state == nil {
		return nil, false
	}
	cloned := &qqMobileQRState{
		Status:    state.Status,
		Message:   state.Message,
		Cookie:    state.Cookie,
		Cookies:   cloneCookieMap(state.Cookies),
		Extra:     cloneCookieMap(state.Extra),
		ExpiresAt: state.ExpiresAt,
	}
	return cloned, true
}

func updateQQMobileQR(qrcodeID string, state *qqMobileQRState) {
	qqMobileQRMu.Lock()
	defer qqMobileQRMu.Unlock()
	if _, ok := qqMobileQRPending[qrcodeID]; ok {
		qqMobileQRPending[qrcodeID] = state
	}
}

func setQQMobileQRExtra(qrcodeID string, extra map[string]string) {
	qqMobileQRMu.Lock()
	defer qqMobileQRMu.Unlock()
	if state := qqMobileQRPending[qrcodeID]; state != nil {
		if state.Extra == nil {
			state.Extra = map[string]string{}
		}
		for k, v := range extra {
			k = strings.TrimSpace(k)
			v = strings.TrimSpace(v)
			if k != "" && v != "" {
				state.Extra[k] = v
			}
		}
	}
}

func markQQMobileQRScanned(qrcodeID string) {
	qqMobileQRMu.Lock()
	defer qqMobileQRMu.Unlock()
	if state := qqMobileQRPending[qrcodeID]; state != nil && state.Status == model.QRLoginStatusWaiting {
		state.Status = model.QRLoginStatusScanned
		state.Message = "已扫码,请在手机上确认"
	}
}

func completeQQMobileQR(qrcodeID string, cookies map[string]string, extra map[string]string) {
	qqMobileQRMu.Lock()
	defer qqMobileQRMu.Unlock()
	if state := qqMobileQRPending[qrcodeID]; state != nil {
		state.Status = model.QRLoginStatusSuccess
		state.Message = "登录成功"
		state.Cookies = normalizeQQMusicCookies(cookies)
		state.Cookie = joinCookieMap(state.Cookies)
		state.Extra = cloneCookieMap(extra)
	}
}

func setQQMobileQRFailed(qrcodeID, message string) {
	setQQMobileQRFailedWithExtra(qrcodeID, message, nil)
}

func setQQMobileQRFailedWithExtra(qrcodeID, message string, extra map[string]string) {
	qqMobileQRMu.Lock()
	defer qqMobileQRMu.Unlock()
	if state := qqMobileQRPending[qrcodeID]; state != nil && state.Status != model.QRLoginStatusSuccess {
		state.Status = model.QRLoginStatusFailed
		state.Message = strings.TrimSpace(message)
		if state.Message == "" {
			state.Message = "登录失败"
		}
		if state.Extra == nil {
			state.Extra = map[string]string{}
		}
		for k, v := range extra {
			k = strings.TrimSpace(k)
			v = strings.TrimSpace(v)
			if k != "" && v != "" {
				state.Extra[k] = v
			}
		}
	}
}

func failQQMobileQR(qrcodeID string, err error) {
	failQQMobileQRWithExtra(qrcodeID, err, nil)
}

func failQQMobileQRWithExtra(qrcodeID string, err error, extra map[string]string) {
	if err == nil {
		setQQMobileQRFailedWithExtra(qrcodeID, "登录失败", extra)
		return
	}
	setQQMobileQRFailedWithExtra(qrcodeID, err.Error(), extra)
}

func expireQQMobileQR(qrcodeID string) {
	qqMobileQRMu.Lock()
	defer qqMobileQRMu.Unlock()
	if state := qqMobileQRPending[qrcodeID]; state != nil && state.Status != model.QRLoginStatusSuccess {
		state.Status = model.QRLoginStatusExpired
		state.Message = "二维码已过期,请刷新"
	}
}

func cleanupQQMobileQRPending() {
	qqMobileQRMu.Lock()
	defer qqMobileQRMu.Unlock()
	now := time.Now()
	for key, state := range qqMobileQRPending {
		if state == nil || now.After(state.ExpiresAt.Add(2*time.Minute)) {
			delete(qqMobileQRPending, key)
		}
	}
}

func qqMobileCredentialData(data map[string]interface{}) (map[string]interface{}, error) {
	if data == nil {
		return nil, fmt.Errorf("qq mobile login returned empty data")
	}
	if nested, ok := data["data"].(map[string]interface{}); ok {
		if code, ok := numberAsInt64(data["code"]); ok && code != 0 {
			return nil, fmt.Errorf("qq mobile login api error code %d", code)
		}
		return nested, nil
	}
	if _, ok := data["musickey"]; ok {
		return data, nil
	}
	if _, ok := data["musicid"]; ok {
		return data, nil
	}
	return data, nil
}

func nestedCookieValue(payload map[string]interface{}, name string) string {
	cookies, _ := payload["cookies"].(map[string]interface{})
	if cookies == nil {
		return ""
	}
	item, _ := cookies[name].(map[string]interface{})
	if item == nil {
		return ""
	}
	return strings.TrimSpace(stringFromInterface(item["value"]))
}

func qqMobilePayloadMap(packet *paho.Publish) (map[string]interface{}, error) {
	if packet == nil || len(packet.Payload) == 0 {
		return map[string]interface{}{}, nil
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(packet.Payload, &payload); err != nil {
		return map[string]interface{}{}, err
	}
	return payload, nil
}

func qqMobileMessageType(packet *paho.Publish, payload map[string]interface{}) string {
	if packet != nil && packet.Properties != nil {
		if value := normalizeQQMobileEvent(packet.Properties.User.Get("type")); value != "" {
			return value
		}
	}
	if value := normalizeQQMobileEvent(qqMobilePayloadText(payload, "type", "event", "status", "action", "messageType")); value != "" {
		return value
	}
	if qqMobileCookieValue(payload, "qqmusic_key", "musickey", "qm_keyst") != "" {
		return "cookies"
	}
	return ""
}

func normalizeQQMobileEvent(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, "_", "")
	value = strings.ReplaceAll(value, "-", "")
	switch value {
	case "scanned", "scan", "qrscanned":
		return "scanned"
	case "canceled", "cancelled", "cancel":
		return "canceled"
	case "timeout", "expired":
		return "timeout"
	case "loginfailed", "failed", "fail":
		return "loginFailed"
	case "cookies", "cookie", "login", "success":
		return "cookies"
	default:
		return ""
	}
}

func qqMobileMessageExtra(packet *paho.Publish, payload map[string]interface{}) map[string]string {
	extra := map[string]string{"stage": "mqtt_message"}
	if packet != nil {
		if packet.Topic != "" {
			extra["topic"] = safeQQMobileTopic(packet.Topic)
		}
		if packet.Properties != nil {
			if props := qqMobileUserPropertyNames(packet.Properties.User); len(props) > 0 {
				extra["user_properties"] = strings.Join(props, ",")
			}
		}
	}
	if len(payload) > 0 {
		extra["payload_keys"] = strings.Join(mapKeys(payload), ",")
	}
	if names := qqMobileCookieNames(payload); len(names) > 0 {
		extra["cookie_names"] = strings.Join(names, ",")
	}
	return extra
}

func safeQQMobileTopic(topic string) string {
	before, _, ok := strings.Cut(topic, "/")
	if ok {
		return before
	}
	return topic
}

func qqMobileUserPropertyNames(props paho.UserProperties) []string {
	names := make([]string, 0, len(props))
	seen := map[string]bool{}
	for _, prop := range props {
		key := strings.TrimSpace(prop.Key)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		names = append(names, key)
	}
	sort.Strings(names)
	return names
}

func qqMobilePayloadText(payload map[string]interface{}, keys ...string) string {
	if payload == nil {
		return ""
	}
	if value := stringFromMapCaseInsensitive(payload, keys...); value != "" {
		return value
	}
	if data, _ := payload["data"].(map[string]interface{}); data != nil {
		return stringFromMapCaseInsensitive(data, keys...)
	}
	return ""
}

func qqMobileCookieValue(payload map[string]interface{}, names ...string) string {
	if payload == nil {
		return ""
	}
	if value := qqMobileCookieValueFromMap(payload, names...); value != "" {
		return value
	}
	if data, _ := payload["data"].(map[string]interface{}); data != nil {
		if value := qqMobileCookieValueFromMap(data, names...); value != "" {
			return value
		}
	}
	return ""
}

func qqMobileCookieValueFromMap(data map[string]interface{}, names ...string) string {
	if value := stringFromMapCaseInsensitive(data, names...); value != "" {
		return value
	}
	for _, key := range []string{"cookie", "Cookie", "cookie_string", "cookieString"} {
		if cookie := strings.TrimSpace(stringFromInterface(data[key])); cookie != "" {
			parsed := parseCookieString(cookie)
			for _, name := range names {
				if value := firstCookieValue(parsed, name); value != "" {
					return value
				}
			}
		}
	}
	cookies := data["cookies"]
	if cookies == nil {
		cookies = data["cookieMap"]
	}
	switch v := cookies.(type) {
	case map[string]interface{}:
		for _, name := range names {
			if value := qqMobileCookieValueFromAny(mapValueCaseInsensitive(v, name)); value != "" {
				return value
			}
		}
	case []interface{}:
		for _, item := range v {
			itemMap, _ := item.(map[string]interface{})
			if itemMap == nil {
				continue
			}
			name := stringFromMapCaseInsensitive(itemMap, "name", "key")
			if !matchesCookieName(name, names...) {
				continue
			}
			if value := qqMobileCookieValueFromAny(mapValueCaseInsensitive(itemMap, "value")); value != "" {
				return value
			}
		}
	case string:
		parsed := parseCookieString(v)
		for _, name := range names {
			if value := firstCookieValue(parsed, name); value != "" {
				return value
			}
		}
	}
	return ""
}

func qqMobileCookieValueFromAny(value interface{}) string {
	if nested, _ := value.(map[string]interface{}); nested != nil {
		return firstNonEmptyQQ(
			stringFromMapCaseInsensitive(nested, "value", "val", "cookie_value", "cookieValue"),
			stringFromInterface(value),
		)
	}
	return strings.TrimSpace(stringFromInterface(value))
}

func qqMobileCookieNames(payload map[string]interface{}) []string {
	names := map[string]bool{}
	add := func(name string) {
		name = strings.TrimSpace(name)
		if name != "" {
			names[name] = true
		}
	}
	var scan func(map[string]interface{})
	scan = func(data map[string]interface{}) {
		if data == nil {
			return
		}
		for _, key := range []string{"cookie", "Cookie", "cookie_string", "cookieString"} {
			if cookie := strings.TrimSpace(stringFromInterface(data[key])); cookie != "" {
				for name := range parseCookieString(cookie) {
					add(name)
				}
			}
		}
		cookies := data["cookies"]
		if cookies == nil {
			cookies = data["cookieMap"]
		}
		switch v := cookies.(type) {
		case map[string]interface{}:
			for key := range v {
				add(key)
			}
		case []interface{}:
			for _, item := range v {
				itemMap, _ := item.(map[string]interface{})
				add(stringFromMapCaseInsensitive(itemMap, "name", "key"))
			}
		case string:
			for name := range parseCookieString(v) {
				add(name)
			}
		}
	}
	scan(payload)
	if data, _ := payload["data"].(map[string]interface{}); data != nil {
		scan(data)
	}
	result := make([]string, 0, len(names))
	for name := range names {
		result = append(result, name)
	}
	sort.Strings(result)
	return result
}

func stringFromMapCaseInsensitive(data map[string]interface{}, keys ...string) string {
	if data == nil {
		return ""
	}
	for _, key := range keys {
		if value := strings.TrimSpace(stringFromInterface(data[key])); value != "" {
			return value
		}
	}
	for _, key := range keys {
		for actual, value := range data {
			if strings.EqualFold(strings.TrimSpace(actual), strings.TrimSpace(key)) {
				if text := strings.TrimSpace(stringFromInterface(value)); text != "" {
					return text
				}
			}
		}
	}
	return ""
}

func mapValueCaseInsensitive(data map[string]interface{}, key string) interface{} {
	if data == nil {
		return nil
	}
	if value, ok := data[key]; ok {
		return value
	}
	for actual, value := range data {
		if strings.EqualFold(strings.TrimSpace(actual), strings.TrimSpace(key)) {
			return value
		}
	}
	return nil
}

func firstCookieValue(cookies map[string]string, name string) string {
	if cookies == nil {
		return ""
	}
	if value := strings.TrimSpace(cookies[name]); value != "" {
		return value
	}
	for actual, value := range cookies {
		if strings.EqualFold(strings.TrimSpace(actual), strings.TrimSpace(name)) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func matchesCookieName(name string, names ...string) bool {
	for _, candidate := range names {
		if strings.EqualFold(strings.TrimSpace(name), strings.TrimSpace(candidate)) {
			return true
		}
	}
	return false
}

func stringFromMap(data map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if value := stringFromInterface(data[key]); strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func int64FromMap(data map[string]interface{}, keys ...string) int64 {
	for _, key := range keys {
		if value, ok := numberAsInt64(data[key]); ok {
			return value
		}
	}
	return 0
}

func stringFromInterface(value interface{}) string {
	switch v := value.(type) {
	case string:
		return v
	case float64:
		if v == float64(int64(v)) {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case json.Number:
		return v.String()
	default:
		return ""
	}
}

func numberAsInt64(value interface{}) (int64, bool) {
	switch v := value.(type) {
	case int:
		return int64(v), true
	case int64:
		return v, true
	case float64:
		return int64(v), true
	case json.Number:
		n, err := v.Int64()
		return n, err == nil
	default:
		return 0, false
	}
}

func mapKeys(data map[string]interface{}) []string {
	keys := make([]string, 0, len(data))
	for key, value := range data {
		if strings.TrimSpace(key) != "" && value != nil {
			keys = append(keys, strings.TrimSpace(key))
		}
	}
	sort.Strings(keys)
	return keys
}

func normalizeQQMusicCookies(cookies map[string]string) map[string]string {
	result := make(map[string]string, len(cookies)+4)
	for k, v := range cookies {
		result[k] = v
	}
	if result["uin"] == "" {
		result["uin"] = firstNonEmptyQQ(result["ptui_loginuin"], result["luin"], result["pt2gguin"], result["superuin"], result["p_uin"], result["musicid"], result["userid"], result["wxuin"])
	}
	if result["qqmusic_key"] == "" {
		result["qqmusic_key"] = firstNonEmptyQQ(result["p_skey"], result["skey"], result["musickey"])
	}
	if result["qm_keyst"] == "" {
		result["qm_keyst"] = result["qqmusic_key"]
	}
	return result
}

func hash33(s string) int {
	h := 0
	for _, c := range s {
		h += (h << 5) + int(c)
	}
	return h & 0x7fffffff
}

func hash33WithSeed(s string, seed int) int {
	h := seed
	for _, c := range s {
		h += (h << 5) + int(c)
	}
	return h & 0x7fffffff
}

func firstNonEmptyQQ(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func parseQQCookieUnix(raw string) (int64, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, false
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	return value, err == nil
}

func qqCookieRefreshable(cookies map[string]string) bool {
	return firstNonEmptyQQ(cookies["musicid"], cookies["qqmusic_uin"], cookies["str_musicid"], cookies["uin"]) != "" &&
		firstNonEmptyQQ(cookies["musickey"], cookies["qqmusic_key"], cookies["qm_keyst"]) != "" &&
		strings.TrimSpace(cookies["refresh_key"]) != "" &&
		strings.TrimSpace(cookies["refresh_token"]) != ""
}

func normalizeQQLoginType(loginType string) string {
	loginType = strings.ToLower(strings.TrimSpace(loginType))
	switch loginType {
	case "mobile", "app", "qqmusic", "qq_music":
		return "mobile"
	case "wx", "wechat", "weixin":
		return "wx"
	default:
		return "qq"
	}
}

func parseCookieString(cookie string) map[string]string {
	result := map[string]string{}
	for _, part := range strings.Split(cookie, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		if k != "" && v != "" {
			result[k] = v
		}
	}
	return result
}

func cloneCookieMap(cookies map[string]string) map[string]string {
	cloned := make(map[string]string, len(cookies))
	for k, v := range cookies {
		if strings.TrimSpace(k) != "" && strings.TrimSpace(v) != "" {
			cloned[k] = v
		}
	}
	return cloned
}

func cookieNames(cookies map[string]string) []string {
	names := make([]string, 0, len(cookies))
	for k, v := range cookies {
		if strings.TrimSpace(k) != "" && strings.TrimSpace(v) != "" {
			names = append(names, strings.TrimSpace(k))
		}
	}
	sort.Strings(names)
	return names
}

func safeLocation(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "-"
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "(unparseable)"
	}
	if parsed.Host == "" {
		return parsed.Path
	}
	return parsed.Scheme + "://" + parsed.Host + parsed.Path
}

func joinCookieMap(cookies map[string]string) string {
	keys := make([]string, 0, len(cookies))
	for key := range cookies {
		if strings.TrimSpace(key) != "" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+"="+cookies[key])
	}
	return strings.Join(parts, "; ")
}

func responseCookies(resp *http.Response) map[string]string {
	cookies := map[string]string{}
	for _, cookie := range resp.Cookies() {
		if strings.TrimSpace(cookie.Name) != "" {
			cookies[cookie.Name] = cookie.Value
		}
	}
	return cookies
}

func base64StdEncode(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

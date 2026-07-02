package qq

import (
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
	"time"

	"github.com/guohuiyuan/music-lib/model"
)

const (
	qqQRShowAPI      = "https://ssl.ptlogin2.qq.com/ptqrshow"
	qqQRCheckAPI     = "https://ssl.ptlogin2.qq.com/ptqrlogin"
	qqWXQRConnectAPI = "https://open.weixin.qq.com/connect/qrconnect"
	qqWXQRCheckAPI   = "https://lp.open.weixin.qq.com/connect/l/qrconnect"
	qqWXRedirectURI  = "https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/"
	qqWXAppID        = "wx48db31d50e334801"
)

func CreateQRLogin() (*model.QRLoginSession, error) { return defaultQQ.CreateQRLogin() }

func CheckQRLogin(key string) (*model.QRLoginResult, error) { return defaultQQ.CheckQRLogin(key) }

func CreateWXQRLogin() (*model.QRLoginSession, error) { return defaultQQ.CreateWXQRLogin() }

func CheckWXQRLogin(key string) (*model.QRLoginResult, error) { return defaultQQ.CheckWXQRLogin(key) }

func CreateQRLoginByType(loginType string) (*model.QRLoginSession, error) {
	return defaultQQ.CreateQRLoginByType(loginType)
}

func CheckQRLoginByType(loginType, key string) (*model.QRLoginResult, error) {
	return defaultQQ.CheckQRLoginByType(loginType, key)
}

func (q *QQ) CreateQRLoginByType(loginType string) (*model.QRLoginSession, error) {
	switch normalizeQQLoginType(loginType) {
	case "wx":
		return q.CreateWXQRLogin()
	default:
		return q.CreateQRLogin()
	}
}

func (q *QQ) CheckQRLoginByType(loginType, key string) (*model.QRLoginResult, error) {
	switch normalizeQQLoginType(loginType) {
	case "wx":
		return q.CheckWXQRLogin(key)
	default:
		return q.CheckQRLogin(key)
	}
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
	req.Header.Set("Referer", "https://y.qq.com/")
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

	params := url.Values{}
	params.Set("u1", "https://graph.qq.com/oauth2.0/login_jump")
	params.Set("ptqrtoken", strconv.Itoa(hash33(qrsig)))
	params.Set("ptredirect", "100")
	params.Set("h", "1")
	params.Set("t", "1")
	params.Set("g", "1")
	params.Set("from_ui", "1")
	params.Set("ptlang", "2052")
	params.Set("action", fmt.Sprintf("0-0-%d", time.Now().UnixMilli()))
	params.Set("js_ver", "21072115")
	params.Set("js_type", "1")
	params.Set("login_sig", "")
	params.Set("pt_uistyle", "40")
	params.Set("aid", "716027609")
	params.Set("daid", "383")
	params.Set("pt_3rd_aid", "100497308")
	params.Set("has_onekey", "1")
	params.Set("pttype", "1")
	params.Set("service", "ptqrlogin")
	params.Set("nodirect", "0")

	req, err := http.NewRequest("GET", qqQRCheckAPI+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	req.Header.Set("Referer", "https://xui.ptlogin2.qq.com/")
	req.Header.Set("Cookie", "qrsig="+qrsig)
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

	cookies := responseCookies(resp)
	strongSaved := false
	if uin != "" && sigx != "" {
		strongCookies, extra, err := fetchQQConnectLoginCookies(uin, sigx)
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

func fetchQQConnectLoginCookies(uin, sigx string) (map[string]string, map[string]string, error) {
	checkCookies, err := fetchQQCheckSigCookies(uin, sigx)
	if err != nil {
		return nil, nil, err
	}
	pSkey := strings.TrimSpace(checkCookies["p_skey"])
	if pSkey == "" {
		return nil, nil, fmt.Errorf("qq connect check_sig missing p_skey")
	}

	code, authCookies, err := fetchQQAuthorizeCode(checkCookies, pSkey)
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
	return normalizeQQMusicCookies(checkCookies), extra, nil
}

func fetchQQCheckSigCookies(uin, sigx string) (map[string]string, error) {
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

	client := &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequest("GET", "https://ssl.ptlogin2.graph.qq.com/check_sig?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	req.Header.Set("Referer", "https://xui.ptlogin2.qq.com/")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	cookies := responseCookies(resp)
	if strings.TrimSpace(cookies["p_skey"]) == "" {
		return nil, fmt.Errorf("qq connect check_sig did not return p_skey")
	}
	return cookies, nil
}

func fetchQQAuthorizeCode(cookies map[string]string, pSkey string) (string, map[string]string, error) {
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
	form.Set("g_tk", strconv.Itoa(hash33WithSeed(pSkey, 5381)))
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
		return "", authCookies, fmt.Errorf("qq connect authorize missing redirect location")
	}
	parsed, err := url.Parse(location)
	if err != nil {
		return "", authCookies, err
	}
	code := strings.TrimSpace(parsed.Query().Get("code"))
	if code == "" {
		return "", authCookies, fmt.Errorf("qq connect authorize missing code")
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

func normalizeQQLoginType(loginType string) string {
	loginType = strings.ToLower(strings.TrimSpace(loginType))
	switch loginType {
	case "wx", "wechat", "weixin":
		return "wx"
	default:
		return "qq"
	}
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

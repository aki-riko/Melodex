package web

import (
	"sort"
	"strconv"
	"strings"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

var storeProviderCookie = func(source, cookie string) {
	core.CM.SetAll(map[string]string{source: cookie})
	core.CM.Save()
}

func persistSuccessfulProviderLogin(source string, result *model.LoginResult) {
	cookie := loginCookieHeader(result)
	if cookie == "" {
		return
	}
	source = canonicalCookieProvider(source)
	result.RawCookie = cookie
	storeProviderCookie(source, cookie)
	metadata := result.Metadata
	if metadata == nil {
		metadata = make(map[string]string, 3)
		result.Metadata = metadata
	}
	metadata["cookie_saved"] = strconv.FormatBool(true)
	metadata["cookie_source"] = source
	metadata["cookie_length"] = strconv.Itoa(len(cookie))
}

func loginCookieHeader(result *model.LoginResult) string {
	if result == nil {
		return ""
	}
	if existing := strings.TrimSpace(result.RawCookie); existing != "" {
		return existing
	}
	keys := nonEmptyCookieKeys(result.CookieValues)
	var header strings.Builder
	for index, key := range keys {
		if index > 0 {
			header.WriteString("; ")
		}
		header.WriteString(key)
		header.WriteByte('=')
		header.WriteString(strings.TrimSpace(result.CookieValues[key]))
	}
	return header.String()
}

func nonEmptyCookieKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key, value := range values {
		if strings.TrimSpace(key) != "" && strings.TrimSpace(value) != "" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys
}

func canonicalCookieProvider(source string) string {
	source = strings.TrimSpace(source)
	aliases := map[string]string{"qq_wx": "qq", "qq_mobile": "qq", "qq_connect": "qq"}
	if canonical, exists := aliases[source]; exists {
		return canonical
	}
	return source
}

package core

import (
	"net/http"
	"strings"
	"time"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

const (
	commonDesktopUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
	legacyMobileUserAgent  = "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1"
)

type sourceRequestProfile struct {
	userAgent string
	referer   string
}

var sourceRequestProfiles = map[string]sourceRequestProfile{
	"bilibili": {referer: "https://www.bilibili.com/"},
	"netease":  {referer: "http://music.163.com/"},
	"migu":     {userAgent: legacyMobileUserAgent, referer: "http://music.migu.cn/"},
	"qq":       {referer: "http://y.qq.com"},
}

func BuildSourceRequest(method, urlString, source, rangeHeader string) (*http.Request, error) {
	request, err := http.NewRequest(method, urlString, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", commonDesktopUserAgent)
	if rangeHeader = strings.TrimSpace(rangeHeader); rangeHeader != "" {
		request.Header.Set("Range", rangeHeader)
	}
	applyProviderMediaHeaders(request, urlString)

	profile := sourceRequestProfiles[strings.TrimSpace(source)]
	if profile.userAgent != "" {
		request.Header.Set("User-Agent", profile.userAgent)
	}
	if profile.referer != "" {
		request.Header.Set("Referer", profile.referer)
	}
	if cookie := cookieForSource(source); cookie != "" {
		request.Header.Set("Cookie", cookie)
	}
	return request, nil
}

func ValidatePlayable(track *model.Track) bool {
	if track == nil || strings.TrimSpace(track.ID) == "" || strings.TrimSpace(track.Source) == "" {
		return false
	}
	if track.Source == "soda" || track.Source == "fivesing" {
		return false
	}
	resolve := GetDownloadFunc(track.Source)
	if resolve == nil {
		return false
	}
	mediaURL, err := resolve(track)
	if err != nil || strings.TrimSpace(mediaURL) == "" {
		return false
	}

	request, err := BuildSourceRequest(http.MethodGet, mediaURL, track.Source, "bytes=0-1")
	if err != nil {
		return false
	}
	response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode == http.StatusOK || response.StatusCode == http.StatusPartialContent
}

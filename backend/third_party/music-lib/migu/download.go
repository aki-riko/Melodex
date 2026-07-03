package migu

import (
	"errors"
	"fmt"
	"github.com/guohuiyuan/music-lib/model"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func GetDownloadURL(s *model.Song) (string, error) { return defaultMigu.GetDownloadURL(s) }

// GetDownloadURL 获取下载链接
func (m *Migu) GetDownloadURL(s *model.Song) (string, error) {
	if s.Source != "migu" {
		return "", errors.New("source mismatch")
	}
	if s.URL != "" {
		return s.URL, nil
	}

	var contentID, resourceType, formatType string
	var candidates []miguFormatCandidate
	if s.Extra != nil {
		contentID = s.Extra["content_id"]
		resourceType = s.Extra["resource_type"]
		formatType = s.Extra["format_type"]
		if strings.TrimSpace(m.cookie) != "" {
			candidates = decodeMiguFormatCandidates(s.Extra[miguFormatCandidateExtraKey])
		}
	}

	if contentID == "" || resourceType == "" || formatType == "" {
		parts := strings.Split(s.ID, "|")
		if len(parts) == 3 {
			contentID = parts[0]
			resourceType = parts[1]
			formatType = parts[2]
		} else {
			return "", errors.New("invalid id structure and missing extra data")
		}
	}

	candidates = appendMiguFormatCandidate(candidates, resourceType, formatType)
	var lastErr error
	for _, candidate := range candidates {
		location, ok, err := m.fetchListenSongLocation(contentID, candidate.ResourceType, candidate.FormatType)
		if err != nil {
			lastErr = err
			continue
		}
		if ok {
			return location, nil
		}
	}
	if lastErr != nil && len(candidates) == 1 {
		return "", lastErr
	}

	// Fall back to the legacy behavior for edge cases where the endpoint returns
	// a playable response directly instead of a redirect.
	return buildMiguListenSongURL(contentID, resourceType, formatType), nil
}

func appendMiguFormatCandidate(candidates []miguFormatCandidate, resourceType, formatType string) []miguFormatCandidate {
	resourceType = strings.TrimSpace(resourceType)
	formatType = strings.TrimSpace(formatType)
	if resourceType == "" || formatType == "" {
		return candidates
	}
	for _, candidate := range candidates {
		if candidate.ResourceType == resourceType && candidate.FormatType == formatType {
			return candidates
		}
	}
	return append(candidates, miguFormatCandidate{ResourceType: resourceType, FormatType: formatType})
}

func buildMiguListenSongURL(contentID, resourceType, formatType string) string {
	params := url.Values{}
	params.Set("toneFlag", formatType)
	params.Set("netType", "00")
	params.Set("userId", MagicUserID)
	params.Set("ua", "Android_migu")
	params.Set("version", "5.1")
	params.Set("copyrightId", "0")
	params.Set("contentId", contentID)
	params.Set("resourceType", resourceType)
	params.Set("channel", "0")

	return "http://app.pd.nf.migu.cn/MIGUM2.0/v1.0/content/sub/listenSong.do?" + params.Encode()
}

func (m *Migu) fetchListenSongLocation(contentID, resourceType, formatType string) (string, bool, error) {
	apiURL := buildMiguListenSongURL(contentID, resourceType, formatType)
	client := &http.Client{
		Timeout: 8 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	req, err := http.NewRequest("GET", apiURL, nil)
	if err != nil {
		return "", false, err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", Referer)
	req.Header.Set("Cookie", m.cookie)

	resp, err := client.Do(req)
	if err != nil {
		return "", false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == 302 {
		location := resp.Header.Get("Location")
		if location != "" {
			return location, true, nil
		}
	}

	if resp.StatusCode >= 400 {
		return "", false, fmt.Errorf("migu listenSong status=%d", resp.StatusCode)
	}
	return "", false, nil
}

package qq

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/guohuiyuan/music-lib/model"
	"github.com/guohuiyuan/music-lib/utils"
	"math/rand"
	"strings"
	"time"
)

func GetDownloadURL(s *model.Song) (string, error) { return defaultQQ.GetDownloadURL(s) }

// GetDownloadURL returns a download URL.
func (q *QQ) GetDownloadURL(s *model.Song) (string, error) {
	if s.Source != "qq" {
		return "", errors.New("source mismatch")
	}

	songMID := s.ID
	if s.Extra != nil && s.Extra["songmid"] != "" {
		songMID = s.Extra["songmid"]
	}

	uin, musicKey := qqCredentialFromCookie(q.cookie)

	// Request qualities from best to worst and use the first successful one.
	// Do not gate this behind IsVipAccount: that probe is only a status hint and
	// may fail for a single test track even when the saved music key can unlock
	// the target song.
	if strings.TrimSpace(musicKey) != "" {
		prefixes := []string{"AI00", "Q001", "Q000", "F000", "O801", "M800", "M500"} // Master, Atmos5.1, Atmos2.0, FLAC, 640k, 320k, 128k
		exts := []string{"flac", "flac", "flac", "flac", "ogg", "mp3", "mp3"}
		if url, err := q.getDownloadURLForPrefixes(songMID, uin, musicKey, true, prefixes, exts); err == nil {
			return url, nil
		}
	}

	// If the saved QQ music key is expired or the account is not VIP, sending it
	// can make QQ return no purl even for tracks that anonymous users can play.
	return q.getDownloadURLForPrefixes(songMID, uin, "", false, []string{"M800", "M500"}, []string{"mp3", "mp3"})
}

func (q *QQ) getDownloadURLForPrefixes(songMID, uin, musicKey string, useAuth bool, prefixes, exts []string) (string, error) {
	if len(prefixes) == 0 || len(prefixes) != len(exts) {
		return "", errors.New("invalid qq quality request")
	}
	if strings.TrimSpace(uin) == "" {
		uin = "0"
	}

	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	guid := fmt.Sprintf("%d", r.Int63n(9000000000)+1000000000)
	var filenames []string
	var songmids []string
	var songtypes []int

	for i := range prefixes {
		filename := fmt.Sprintf("%s%s%s.%s", prefixes[i], songMID, songMID, exts[i])
		filenames = append(filenames, filename)
		songmids = append(songmids, songMID)
		songtypes = append(songtypes, 0)
	}

	reqData := map[string]interface{}{
		"comm": map[string]interface{}{
			"cv":          4747474,
			"ct":          24,
			"format":      "json",
			"inCharset":   "utf-8",
			"outCharset":  "utf-8",
			"notice":      0,
			"platform":    "yqq.json",
			"needNewCode": 1,
			"uin":         uin,
		},
		"req_1": map[string]interface{}{
			"module": "music.vkey.GetVkey",
			"method": "UrlGetVkey",
			"param": map[string]interface{}{
				"guid":      guid,
				"songmid":   songmids,
				"songtype":  songtypes,
				"uin":       uin,
				"loginflag": 1,
				"platform":  "20",
				"filename":  filenames,
			},
		},
	}
	if useAuth && strings.TrimSpace(musicKey) != "" {
		token := hash33WithSeed(musicKey, 5381)
		reqData["comm"].(map[string]interface{})["g_tk"] = token
		reqData["comm"].(map[string]interface{})["g_tk_new_20200303"] = token
		reqData["comm"].(map[string]interface{})["qq"] = uin
		reqData["comm"].(map[string]interface{})["authst"] = musicKey
	}

	jsonData, _ := json.Marshal(reqData)
	headers := []utils.RequestOption{
		utils.WithHeader("User-Agent", UserAgent),
		utils.WithHeader("Referer", DownloadReferer),
		utils.WithHeader("Content-Type", "application/json"),
		utils.WithRandomIPHeader(),
	}
	if useAuth {
		headers = append(headers, utils.WithHeader("Cookie", q.cookie))
	}

	body, err := qqMusicuPost(jsonData, headers...)
	if err != nil {
		return "", err
	}

	var result struct {
		Req1 struct {
			Data struct {
				MidUrlInfo []struct {
					Filename string `json:"filename"`
					Purl     string `json:"purl"`
				} `json:"midurlinfo"`
			} `json:"data"`
		} `json:"req_1"`
	}

	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("qq geturl json parse error: %w", err)
	}

	// Because we passed the filenames cleanly prioritized down from best to worst, the mapped return array technically aligns 1:1.
	// We'll iterate the initial array order we asked for and grab the first `Filename` that successfully gave a `Purl`.
	for _, expectedFilename := range filenames {
		for _, info := range result.Req1.Data.MidUrlInfo {
			if info.Filename == expectedFilename && info.Purl != "" {
				return "https://ws.stream.qqmusic.qq.com/" + info.Purl, nil
			}
		}
	}

	return "", errors.New("no valid download url found or vip required")
}

func qqCredentialFromCookie(cookie string) (uin string, musicKey string) {
	cookies := parseCookieString(cookie)
	uin = firstNonEmptyQQ(cookies["str_musicid"], cookies["qqmusic_uin"], cookies["musicid"], cookies["uin"])
	musicKey = firstNonEmptyQQ(cookies["musickey"], cookies["qqmusic_key"], cookies["qm_keyst"])
	if uin == "" {
		uin = "0"
	}
	return uin, musicKey
}

package qq

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/guohuiyuan/music-lib/utils"
	"math/rand"
	"time"
)

var qqVIPPost = utils.Post

func (q *QQ) IsVipAccount() (bool, error) {
	if q.isVipCache != nil {
		return *q.isVipCache, nil
	}

	if q.cookie == "" {
		isVip := false
		q.isVipCache = &isVip
		return false, nil
	}

	// Use a random GUID to reduce the chance of rate limiting.
	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	guid := fmt.Sprintf("%d", r.Int63n(9000000000)+1000000000)

	// Probe a VIP-only song to detect account capability.
	songMID := "004YZbkL2MNHoY"
	// M500/O801 can be returned for anonymous users, so use M800 as the
	// lowest practical probe that distinguishes an effective music key.
	filename := fmt.Sprintf("M800%s%s.mp3", songMID, songMID)
	uin, musicKey := qqCredentialFromCookie(q.cookie)

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
				"songmid":   []string{songMID},
				"songtype":  []int{0},
				"uin":       uin,
				"loginflag": 1,
				"platform":  "20",
				"filename":  []string{filename},
			},
		},
	}
	if musicKey != "" {
		reqData["comm"].(map[string]interface{})["g_tk"] = hash33WithSeed(musicKey, 5381)
		reqData["comm"].(map[string]interface{})["qq"] = uin
		reqData["comm"].(map[string]interface{})["authst"] = musicKey
	}

	jsonData, _ := json.Marshal(reqData)
	headers := []utils.RequestOption{
		utils.WithHeader("User-Agent", UserAgent),
		utils.WithHeader("Referer", DownloadReferer),
		utils.WithHeader("Content-Type", "application/json"),
		utils.WithHeader("Cookie", q.cookie),
		utils.WithRandomIPHeader(),
	}

	body, err := qqVIPPost("https://u.y.qq.com/cgi-bin/musicu.fcg", bytes.NewReader(jsonData), headers...)
	if err != nil {
		return false, err
	}

	var result struct {
		Req1 struct {
			Code int `json:"code"`
			Data struct {
				MidUrlInfo []struct {
					Purl string `json:"purl"`
				} `json:"midurlinfo"`
			} `json:"data"`
		} `json:"req_1"`
	}

	if err := json.Unmarshal(body, &result); err != nil {
		return false, err
	}

	// Cache only when the probe result is conclusive.
	if result.Req1.Code != 0 {
		return false, fmt.Errorf("api returned error code: %d", result.Req1.Code)
	}
	isVip := false
	if len(result.Req1.Data.MidUrlInfo) > 0 {
		isVip = result.Req1.Data.MidUrlInfo[0].Purl != ""
	}

	q.isVipCache = &isVip
	return isVip, nil
}

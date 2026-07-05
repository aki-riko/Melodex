package qq

import (
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/guohuiyuan/music-lib/model"
	"github.com/guohuiyuan/music-lib/utils"
)

var qqLyricHTMLTagRe = regexp.MustCompile(`<[^>]+>`)

func SearchLyrics(keyword string) ([]model.Song, error) {
	return defaultQQ.SearchLyrics(keyword)
}

func (q *QQ) SearchLyrics(keyword string) ([]model.Song, error) {
	params := buildQQSearchParams(keyword, "7", 30)
	apiURL := "http://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?" + params.Encode()

	body, err := utils.Get(apiURL,
		utils.WithHeader("User-Agent", UserAgent),
		utils.WithHeader("Referer", SearchReferer),
		utils.WithHeader("Cookie", q.cookie),
		utils.WithRandomIPHeader(),
	)
	if err != nil {
		return nil, err
	}

	return parseQQLyricSearchResponse(body, q.fetchSongDetailByID)
}

func buildQQSearchParams(keyword, searchType string, limit int) url.Values {
	params := url.Values{}
	params.Set("w", keyword)
	params.Set("format", "json")
	params.Set("p", "1")
	params.Set("n", strconv.Itoa(limit))
	params.Set("t", searchType)
	return params
}

type qqLyricDetailFunc func(string) (*model.Song, error)

func parseQQLyricSearchResponse(body []byte, detailFn qqLyricDetailFunc) ([]model.Song, error) {
	var resp struct {
		Code int `json:"code"`
		Data struct {
			Lyric struct {
				List []struct {
					SongID    int64  `json:"songid"`
					SongMID   string `json:"songmid"`
					SongName  string `json:"songname"`
					AlbumName string `json:"albumname"`
					AlbumMID  string `json:"albummid"`
					Interval  int    `json:"interval"`
					Size128   int64  `json:"size128"`
					Size320   int64  `json:"size320"`
					SizeFlac  int64  `json:"sizeflac"`
					Singer    []struct {
						Name string `json:"name"`
					} `json:"singer"`
					Pay struct {
						PayPlay       int `json:"payplay"`
						PayTrackPrice int `json:"paytrackprice"`
					} `json:"pay"`
					Lyric string `json:"lyric"`
				} `json:"list"`
			} `json:"lyric"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("qq lyric search json parse error: %w", err)
	}
	if resp.Code != 0 {
		return nil, fmt.Errorf("qq lyric search api error code: %d", resp.Code)
	}

	songs := make([]model.Song, 0, len(resp.Data.Lyric.List))
	for _, item := range resp.Data.Lyric.List {
		songID := strconv.FormatInt(item.SongID, 10)
		songMID := strings.TrimSpace(item.SongMID)
		if songMID == "0" {
			songMID = ""
		}

		var detail *model.Song
		if songMID == "" && songID != "" && detailFn != nil {
			if loaded, err := detailFn(songID); err == nil {
				detail = loaded
				if loaded.Extra != nil && strings.TrimSpace(loaded.Extra["songmid"]) != "" {
					songMID = strings.TrimSpace(loaded.Extra["songmid"])
				} else if strings.TrimSpace(loaded.ID) != "" {
					songMID = strings.TrimSpace(loaded.ID)
				}
			}
		}
		if songMID == "" {
			continue
		}

		name := strings.TrimSpace(item.SongName)
		album := strings.TrimSpace(item.AlbumName)
		cover := ""
		if detail != nil {
			if strings.TrimSpace(detail.Name) != "" {
				name = detail.Name
			}
			if strings.TrimSpace(detail.Album) != "" {
				album = detail.Album
			}
			cover = strings.TrimSpace(detail.Cover)
		}
		if cover == "" && strings.TrimSpace(item.AlbumMID) != "" {
			cover = fmt.Sprintf("https://y.gtimg.cn/music/photo_new/T002R300x300M000%s.jpg", item.AlbumMID)
		}

		artistNames := make([]string, 0, len(item.Singer))
		for _, singer := range item.Singer {
			if strings.TrimSpace(singer.Name) != "" {
				artistNames = append(artistNames, singer.Name)
			}
		}
		if len(artistNames) == 0 && detail != nil && strings.TrimSpace(detail.Artist) != "" {
			artistNames = append(artistNames, detail.Artist)
		}

		fileSize := item.Size128
		bitrate := 128
		if item.SizeFlac > 0 {
			fileSize = item.SizeFlac
			if item.Interval > 0 {
				bitrate = int(fileSize * 8 / 1000 / int64(item.Interval))
			} else {
				bitrate = 800
			}
		} else if item.Size320 > 0 {
			fileSize = item.Size320
			bitrate = 320
		}

		extra := map[string]string{
			"songmid":      songMID,
			"song_id":      songID,
			"lyric_match":  cleanQQLyricHTML(item.Lyric),
			"search_match": "lyric",
		}
		if item.SizeFlac > 0 {
			extra["has_lossless"] = "1"
		}
		if item.Pay.PayTrackPrice > 0 {
			extra["is_paid"] = "1"
		}

		songs = append(songs, model.Song{
			Source:   "qq",
			ID:       songMID,
			Name:     name,
			Artist:   strings.Join(artistNames, "、"),
			Album:    album,
			Duration: item.Interval,
			Size:     fileSize,
			Bitrate:  bitrate,
			Cover:    cover,
			Link:     fmt.Sprintf("https://y.qq.com/n/ryqq/songDetail/%s", songMID),
			Extra:    extra,
		})
	}
	if len(songs) == 0 {
		return nil, errors.New("no lyric search results found")
	}
	return songs, nil
}

func cleanQQLyricHTML(raw string) string {
	text := html.UnescapeString(raw)
	text = strings.NewReplacer(
		"<br/>", "\n",
		"<br />", "\n",
		"<br>", "\n",
		"</br>", "\n",
	).Replace(text)
	text = qqLyricHTMLTagRe.ReplaceAllString(text, "")
	lines := strings.FieldsFunc(text, func(r rune) bool { return r == '\n' || r == '\r' })
	cleaned := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" {
			cleaned = append(cleaned, line)
		}
	}
	return strings.Join(cleaned, " / ")
}

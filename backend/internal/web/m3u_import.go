package web

// 歌单导入 m3u/m3u8:解析 #EXTINF 的歌名/歌手,用名字去各音源搜索匹配,
// 把找到的最佳结果(综合排序第1,原唱优先)加进新建歌单。
// m3u 里的本地路径/在线临时 URL 在本服务这边基本用不了,故走"按名重搜匹配"。

import (
	"bufio"
	"encoding/json"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm/clause"
)

// m3uEntry 解析出的一条歌:标题(搜索用)+ 拆出的歌手/歌名。
type m3uEntry struct {
	Title  string // 原始标题(EXTINF 逗号后的部分)
	Artist string
	Name   string
}

// parseM3U 解析 m3u/m3u8 文本,返回条目列表。
// 识别 HLS 视频流(#EXT-X-* 标签)→ 返回 isHLS=true,调用方应拒绝。
func parseM3U(content string) (entries []m3uEntry, isHLS bool) {
	sc := bufio.NewScanner(strings.NewReader(content))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var pendingTitle string
	hasTitle := false
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		// HLS 视频流标签:判定为视频分片播放列表,非音乐歌单
		if strings.HasPrefix(line, "#EXT-X-") {
			isHLS = true
			continue
		}
		if strings.HasPrefix(line, "#EXTINF:") {
			// #EXTINF:时长,标题
			rest := strings.TrimPrefix(line, "#EXTINF:")
			if i := strings.Index(rest, ","); i >= 0 {
				pendingTitle = strings.TrimSpace(rest[i+1:])
				hasTitle = pendingTitle != ""
			}
			continue
		}
		if strings.HasPrefix(line, "#") {
			continue // 其他注释/标签忽略
		}
		// 媒体行:决定搜索词。文件名常含"歌手 - 歌名"(信息比 EXTINF 全,
		// EXTINF 标题常只有歌名),故文件名含分隔符时优先用文件名;否则用 EXTINF 标题。
		fileTitle := guessTitleFromMediaLine(line)
		title := ""
		switch {
		case fileTitle != "" && strings.ContainsAny(fileTitle, "-–—_"):
			title = fileTitle // 文件名带歌手信息,最全
		case hasTitle:
			title = pendingTitle
		default:
			title = fileTitle
		}
		pendingTitle = ""
		hasTitle = false
		if title == "" {
			continue
		}
		artist, name := splitArtistTitle(title)
		entries = append(entries, m3uEntry{Title: title, Artist: artist, Name: name})
	}
	return entries, isHLS
}

// splitArtistTitle 把 "歌手 - 歌名" 拆成 artist/name;无分隔符则整体当 name。
func splitArtistTitle(title string) (artist, name string) {
	for _, sep := range []string{" - ", " – ", " — ", "-", "_"} {
		if i := strings.Index(title, sep); i > 0 {
			return strings.TrimSpace(title[:i]), strings.TrimSpace(title[i+len(sep):])
		}
	}
	return "", strings.TrimSpace(title)
}

// guessTitleFromMediaLine 从媒体行(路径/URL)末段取文件名(去扩展名)做兜底搜索词。
func guessTitleFromMediaLine(line string) string {
	s := line
	if i := strings.IndexAny(s, "?#"); i >= 0 {
		s = s[:i]
	}
	s = strings.TrimRight(s, "/")
	if i := strings.LastIndexAny(s, "/\\"); i >= 0 {
		s = s[i+1:]
	}
	if i := strings.LastIndex(s, "."); i > 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// registerM3UImport 注册 m3u/m3u8 导入端点(由 RegisterCollectionRoutes 调用)。
// POST /music/collections/import_m3u  body: {name?, content}
func registerM3UImport(colAPI *gin.RouterGroup) {
	colAPI.POST("/import_m3u", func(c *gin.Context) {
		uid := currentUserID(c)
		if uid == 0 {
			c.JSON(401, gin.H{"error": "请先登录"})
			return
		}
		var req struct {
			Name    string `json:"name"`
			Content string `json:"content"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Content) == "" {
			c.JSON(400, gin.H{"error": "参数错误,缺少 content"})
			return
		}

		entries, isHLS := parseM3U(req.Content)
		if isHLS {
			c.JSON(400, gin.H{"error": "这是 HLS 视频流播放列表,不是音乐歌单,无法导入"})
			return
		}
		if len(entries) == 0 {
			c.JSON(400, gin.H{"error": "未从文件解析到任何歌曲条目"})
			return
		}

		// 建新歌单(名称缺省用时间)
		name := strings.TrimSpace(req.Name)
		if name == "" {
			name = "导入歌单 " + time.Now().Format("01-02 15:04")
		}
		coll := Collection{
			UserID:      uid,
			Name:        name,
			Kind:        collectionKindManual,
			ContentType: collectionContentPlaylist,
			Source:      "local",
		}
		if err := db.Create(&coll).Error; err != nil {
			c.JSON(500, gin.H{"error": "创建歌单失败: " + err.Error()})
			return
		}

		// 逐条按歌名搜索匹配,取综合排序第1(原唱优先)加入歌单。
		sources := defaultSourcesForSearchType("song")
		matched := 0
		for _, e := range entries {
			query := e.Title
			songs, _ := concurrentKeywordSearch(query, "song", sources)
			if len(songs) == 0 {
				continue
			}
			sortSongsByRelevance(songs, query)
			best := songs[0]
			saved := SavedSong{
				CollectionID: coll.ID,
				SongID:       best.ID,
				Source:       best.Source,
				Name:         best.Name,
				Artist:       best.Artist,
				Cover:        best.Cover,
				Duration:     best.Duration,
			}
			if best.Extra != nil {
				if b, err := json.Marshal(best.Extra); err == nil {
					saved.Extra = string(b)
				}
			}
			if err := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&saved).Error; err == nil {
				matched++
			}
		}

		c.JSON(200, gin.H{
			"id":      coll.ID,
			"name":    coll.Name,
			"total":   len(entries),
			"matched": matched,
			"skipped": len(entries) - matched,
		})
	})
}

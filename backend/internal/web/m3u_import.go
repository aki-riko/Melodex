package web

// 歌单导入 m3u/m3u8:解析 #EXTINF 的歌名/歌手,用名字去各音源搜索匹配,
// 把找到的最佳结果(综合排序第1,原唱优先)加进新建歌单。
// m3u 里的本地路径/在线临时 URL 在本服务这边基本用不了,故走"按名重搜匹配"。

import (
	"bufio"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm/clause"
)

const maxM3UEntries = 1000

var maxM3UImportBodyBytes int64 = 8 * 1024 * 1024

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
		limitRequestBody(c, maxM3UImportBodyBytes)
		var req struct {
			Name    string `json:"name"`
			Content string `json:"content"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			if isRequestBodyTooLarge(err) {
				c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "m3u 文件过大,请拆分后再导入"})
				return
			}
			c.JSON(400, gin.H{"error": "参数错误,缺少 content"})
			return
		}
		if strings.TrimSpace(req.Content) == "" {
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
		// 条目数上限:每条都触发一次全源搜索,限制放大式资源消耗。
		if len(entries) > maxM3UEntries {
			c.JSON(400, gin.H{"error": fmt.Sprintf("歌单条目过多(%d),单次导入上限 %d 条", len(entries), maxM3UEntries)})
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
			respondInternalError(c, "创建歌单失败", err)
			return
		}

		// 逐条按歌名搜索匹配是**分钟级**工作(1000 条 × 主力源 1~2 秒),
		// 不能在请求里同步跑 —— 原实现把前端 600 秒超时撞穿,用户看到"导入失败"
		// 而歌单其实已经建好并在继续填歌。现在改为:建歌单 → 启动后台任务 →
		// 立刻返回 task_id,前端轮询进度。详见 m3u_import_task.go 的说明。
		task, existing := newM3UImportTask(uid, coll.Name, len(entries), coll.ID)
		if existing != nil {
			// 该用户已有进行中的导入:不重复启动(每条都打全源搜索,
			// 并发导入会把上游打爆,与项目"绝不提高上游并发"的纪律相反)。
			c.JSON(200, gin.H{
				"task_id":         existing.ID,
				"id":              existing.collectionID,
				"name":            existing.Name,
				"total":           existing.Total,
				"state":           existing.State(),
				"already_running": true,
			})
			return
		}

		go runM3UImportTask(task, entries)

		c.JSON(200, gin.H{
			"task_id": task.ID,
			"id":      coll.ID,
			"name":    coll.Name,
			"total":   len(entries),
			"state":   m3uImportRunning,
		})
	})

	// 查询导入进度。前端每 ~1 秒轮询一次,直到 state 变成 done/failed/cancelled。
	colAPI.GET("/import_m3u/tasks/:id", func(c *gin.Context) {
		uid := currentUserID(c)
		if uid == 0 {
			c.JSON(401, gin.H{"error": "请先登录"})
			return
		}
		task := lookupM3UImportTask(c.Param("id"), uid)
		if task == nil {
			// 用户不匹配与不存在一律 404 —— 不泄露他人任务是否存在。
			c.JSON(404, gin.H{"error": "导入任务不存在或已过期"})
			return
		}
		c.JSON(200, task.progress())
	})

	// 取消导入。后台循环会在下一条开始前退出,已导入的歌曲保留。
	colAPI.DELETE("/import_m3u/tasks/:id", func(c *gin.Context) {
		uid := currentUserID(c)
		if uid == 0 {
			c.JSON(401, gin.H{"error": "请先登录"})
			return
		}
		task := lookupM3UImportTask(c.Param("id"), uid)
		if task == nil {
			c.JSON(404, gin.H{"error": "导入任务不存在或已过期"})
			return
		}
		task.Cancel()
		c.JSON(200, task.progress())
	})
}

// runM3UImportTask 是导入的后台执行体。
//
// 逐条搜索匹配,每 m3uImportBatchSize 条上报一次进度;用户取消时尽快退出
// (已导入的歌曲保留 —— 半份歌单比全丢更有用,且用户可以再导一次)。
//
// ★ 这里的每一步都要能容忍"进程里还有别的请求在跑":用的是全局 db 句柄,
//
//	与原有实现一致(原本也是在请求 goroutine 里直接用的)。
func runM3UImportTask(task *m3uImportTask, entries []m3uEntry) {
	// 任务结束时:标记终态 + 从 byUser 摘掉(否则同一用户永远只能有一个历史 id)。
	defer task.detach()

	sources := defaultSourcesForSearchType("song")
	matched := 0
	processed := 0

	for _, e := range entries {
		if task.Cancelled() {
			task.finish(m3uImportCancelled, "已取消,已导入的歌曲保留", processed, matched)
			return
		}

		query := e.Title
		songs, _ := concurrentKeywordSearch(query, "song", sources)
		processed++

		if len(songs) > 0 {
			sortSongsByRelevance(songs, query)
			best := songs[0]
			saved := SavedSong{
				CollectionID: task.collectionID,
				SongID:       best.ID,
				Source:       best.Source,
				Name:         best.Name,
				Artist:       best.Artist,
				Cover:        best.Cover,
				Duration:     best.Duration,
				Extra:        encodeSongExtraWithMetadata(best.Extra, best.Album, best.AlbumID),
			}
			if err := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&saved).Error; err == nil {
				matched++
			}
		}

		// 分批上报:每条都刷毫无增益(前端 1 秒才读一次),只是多几次锁竞争。
		if processed%m3uImportBatchSize == 0 {
			task.recordBatch(processed, matched)
		}
	}

	task.finish(m3uImportDone, "", processed, matched)
}

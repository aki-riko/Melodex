package web

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm/clause"
)

// 用户播放历史:按 user_id 隔离,每人最多保留 playHistoryMax 条,
// 同一首歌(source+song_id)重播更新时间(去重),供「最近播放」页展示。
// 与 search_history 同构(按用户隔离 + OnConflict 去重 + 超限剪枝)。
const playHistoryMax = 500

type playHistoryRow struct {
	ID       uint   `gorm:"primaryKey" json:"-"`
	UserID   uint   `gorm:"uniqueIndex:idx_play_user_song;not null" json:"-"`
	SongID   string `gorm:"uniqueIndex:idx_play_user_song;not null" json:"id"`
	Source   string `gorm:"uniqueIndex:idx_play_user_song;not null" json:"source"`
	Name     string `json:"name"`
	Artist   string `json:"artist"`
	Cover    string `json:"cover"`
	Duration int    `json:"duration"`
	// Extra 存源特有元数据(album/album_id/link 等)的原始 JSON 串,
	// 读取时解析回对象,与 collectionSongsJSON 的歌曲结构对齐。
	Extra    string    `json:"-"`
	PlayedAt time.Time `gorm:"autoUpdateTime" json:"played_at"`
}

// recordPlayHistory 记一条播放历史(去重:同用户同歌更新时间)。
// userID=0(未登录/桌面异常)跳过。超过上限时删最旧的。
func recordPlayHistory(userID uint, songID, source, name, artist, cover string, duration int, extra string) {
	songID = strings.TrimSpace(songID)
	source = strings.TrimSpace(source)
	if db == nil || userID == 0 || songID == "" || source == "" {
		return
	}
	row := playHistoryRow{
		UserID:   userID,
		SongID:   songID,
		Source:   source,
		Name:     name,
		Artist:   artist,
		Cover:    cover,
		Duration: duration,
		Extra:    extra,
		PlayedAt: time.Now(),
	}
	// 去重:同 (user_id, song_id, source) 命中则刷新展示字段与播放时间。
	if err := db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}, {Name: "song_id"}, {Name: "source"}},
		DoUpdates: clause.AssignmentColumns([]string{"name", "artist", "cover", "duration", "extra", "played_at"}),
	}).Create(&row).Error; err != nil {
		return
	}
	prunePlayHistory(userID)
}

// prunePlayHistory 保留最近 playHistoryMax 条,删更旧的。
func prunePlayHistory(userID uint) {
	var count int64
	if err := db.Model(&playHistoryRow{}).Where("user_id = ?", userID).Count(&count).Error; err != nil {
		return
	}
	if count <= playHistoryMax {
		return
	}
	// 找出第 playHistoryMax 条的时间界,删更旧的。
	var threshold playHistoryRow
	if err := db.Where("user_id = ?", userID).
		Order("played_at DESC").
		Offset(playHistoryMax - 1).Limit(1).
		Find(&threshold).Error; err != nil || threshold.ID == 0 {
		return
	}
	db.Where("user_id = ? AND played_at < ?", userID, threshold.PlayedAt).Delete(&playHistoryRow{})
}

func listPlayHistory(userID uint, limit int) ([]playHistoryRow, error) {
	if limit <= 0 || limit > playHistoryMax {
		limit = playHistoryMax
	}
	if userID == 0 {
		return []playHistoryRow{}, nil
	}
	var rows []playHistoryRow
	if err := db.Where("user_id = ?", userID).
		Order("played_at DESC").Limit(limit).
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// playHistoryToSongs 把历史行转成与 collectionSongsJSON 对齐的歌曲结构
// (含 extra 解析出的 album/album_id/link),供前端 SongRow 直接渲染/播放。
//
// 副歌点位在这里补(2026-11): 历史行存的是**播放当时**的 extra 快照, 那时还没有
// chorus_* 字段, 而前端进度条只认 extra 里的值 —— 不回填的话用户从「最近播放」
// 点开一首网易歌就永远看不到副歌标记(实测生产就是这么发生的)。
//
// 只补当前返回的这一页(最多 limit 首), 且走 fillChorusForTracks 的统一限流路径:
// 网易一次批量, 酷我串行 ≤5 首。拿不到就静默降级(少一个标记, 不影响列表)。
func playHistoryToSongs(rows []playHistoryRow) []gin.H {
	// 先把所有行解码好, 再一次性按 (source,song_id) 批量补副歌, 避免逐行打上游。
	extras := make([]map[string]string, len(rows))
	identities := make([]chorusIdentity, 0, len(rows))
	for i, r := range rows {
		extras[i] = hydratePlayHistoryAlbumMetadata(&rows[i], decodeSongExtraMap(r.Extra))
		identities = append(identities, chorusIdentity{
			Source: r.Source, SongID: r.SongID, Name: r.Name, Artist: r.Artist,
		})
	}
	points := fillChorusForTracks(identities)

	resp := make([]gin.H, 0, len(rows))
	for i, r := range rows {
		extraMap := extras[i]
		// extra 保持原来的形状(没数据时是 nil 而不是空 map), 除非这次真的补到了副歌 ——
		// 补到时才改成 map, 因为要往里加两个字段。这样既有响应对老客户端完全不变。
		var extraOut interface{} = decodeSongExtraObject(r.Extra)
		if point, ok := points[chorusSourceKey(r.Source, r.SongID)]; ok && point.Valid() {
			applyChorusToExtraMap(extraMap, point)
			extraOut = extraMap
		}
		resp = append(resp, gin.H{
			"id":        r.SongID,
			"source":    r.Source,
			"name":      r.Name,
			"artist":    r.Artist,
			"album":     extraMapAlbum(extraMap),
			"album_id":  extraMapAlbumID(extraMap),
			"cover":     r.Cover,
			"duration":  r.Duration,
			"link":      extraMapValue(extraMap, "link"),
			"extra":     extraOut,
			"played_at": r.PlayedAt,
		})
	}
	return resp
}

// RegisterPlayHistoryRoutes 注册播放历史接口(userAPI,仅登录,按用户隔离)。
func RegisterPlayHistoryRoutes(api *gin.RouterGroup) {
	// 记录一次播放(播放器开始播放时调用,fire-and-forget)。
	api.POST("/play_history", func(c *gin.Context) {
		uid := currentUserID(c)
		if uid == 0 {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
			return
		}
		var req struct {
			SongID   string      `json:"id"`
			Source   string      `json:"source"`
			Name     string      `json:"name"`
			Artist   string      `json:"artist"`
			Album    string      `json:"album"`
			AlbumID  string      `json:"album_id"`
			Cover    string      `json:"cover"`
			Duration int         `json:"duration"`
			Extra    interface{} `json:"extra"`
		}
		if c.ShouldBindJSON(&req) != nil || strings.TrimSpace(req.SongID) == "" || strings.TrimSpace(req.Source) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误,缺少 id 或 source"})
			return
		}
		extraStr := encodeSongExtraWithMetadata(req.Extra, req.Album, req.AlbumID)
		recordPlayHistory(uid, req.SongID, req.Source, req.Name, req.Artist, req.Cover, req.Duration, extraStr)
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// 列最近播放(按 played_at 降序)。
	api.GET("/play_history", func(c *gin.Context) {
		rows, err := listPlayHistory(currentUserID(c), 0)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "读取播放历史失败"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"history": playHistoryToSongs(rows)})
	})

	// 删单条(传 id+source)或清空(都不传)。
	api.DELETE("/play_history", func(c *gin.Context) {
		uid := currentUserID(c)
		if uid == 0 {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
			return
		}
		songID := strings.TrimSpace(c.Query("id"))
		source := strings.TrimSpace(c.Query("source"))
		if songID != "" && source != "" {
			db.Where("user_id = ? AND song_id = ? AND source = ?", uid, songID, source).Delete(&playHistoryRow{})
		} else {
			db.Where("user_id = ?", uid).Delete(&playHistoryRow{})
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
}

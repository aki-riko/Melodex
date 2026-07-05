package web

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const maxFavoriteStatusBatch = 500

type favoriteStatusItem struct {
	SongID    string `json:"id"`
	Source    string `json:"source"`
	Favorited bool   `json:"favorited,omitempty"`
}

func favoritePairKey(source, songID string) string {
	return strings.TrimSpace(source) + "\x1f" + strings.TrimSpace(songID)
}

// ensureFavoriteCollection 返回该用户的「我喜欢」歌单(kind=favorite),不存在则创建。
// 每个用户默认有且仅有一个;幂等。userID=0 视为无效。
func ensureFavoriteCollection(userID uint) (*Collection, error) {
	if userID == 0 || db == nil {
		return nil, gorm.ErrRecordNotFound
	}
	var fav Collection
	err := db.Where("user_id = ? AND kind = ?", userID, collectionKindFavorite).
		Order("id ASC").First(&fav).Error
	if err == nil {
		return &fav, nil
	}
	if err != gorm.ErrRecordNotFound {
		return nil, err
	}
	fav = Collection{
		UserID:      userID,
		Name:        favoriteCollectionName,
		Kind:        collectionKindFavorite,
		ContentType: collectionContentPlaylist,
		Source:      "local",
	}
	// 并发安全:依赖 (user_id) WHERE kind='favorite' 的部分唯一索引;冲突则不重复建,
	// 随后重新查询取已存在的那条。
	if err := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&fav).Error; err != nil {
		return nil, err
	}
	if fav.ID == 0 {
		// OnConflict 命中(已被并发创建),重新查。
		if err := db.Where("user_id = ? AND kind = ?", userID, collectionKindFavorite).
			Order("id ASC").First(&fav).Error; err != nil {
			return nil, err
		}
	}
	return &fav, nil
}

// isSongFavorited 判断某歌是否在用户的「我喜欢」里。
func isSongFavorited(userID uint, source, songID string) (bool, error) {
	fav, err := ensureFavoriteCollection(userID)
	if err != nil {
		return false, err
	}
	var n int64
	if err := db.Model(&SavedSong{}).
		Where("collection_id = ? AND song_id = ? AND source = ?", fav.ID, songID, source).
		Count(&n).Error; err != nil {
		return false, err
	}
	return n > 0, nil
}

// RegisterFavoriteRoutes 注册收藏接口(userAPI,仅登录,按用户隔离)。
func RegisterFavoriteRoutes(api *gin.RouterGroup) {
	// 查询某歌收藏状态
	api.GET("/favorites/status", func(c *gin.Context) {
		uid := currentUserID(c)
		source := strings.TrimSpace(c.Query("source"))
		songID := strings.TrimSpace(c.Query("id"))
		// 路由已在 userAPI(authRequired 保证 uid>0);此处只校验业务参数。
		if source == "" || songID == "" {
			c.JSON(http.StatusOK, gin.H{"favorited": false})
			return
		}
		fav, err := isSongFavorited(uid, source, songID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "查询收藏状态失败"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"favorited": fav})
	})

	api.POST("/favorites/status_batch", func(c *gin.Context) {
		uid := currentUserID(c)
		var req struct {
			Songs []favoriteStatusItem `json:"songs"`
		}
		if c.ShouldBindJSON(&req) != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		if len(req.Songs) > maxFavoriteStatusBatch {
			c.JSON(http.StatusBadRequest, gin.H{"error": "一次最多查询 500 首"})
			return
		}

		items := make([]favoriteStatusItem, 0, len(req.Songs))
		seen := make(map[string]bool, len(req.Songs))
		sources := make([]string, 0, len(req.Songs))
		sourceSeen := map[string]bool{}
		ids := make([]string, 0, len(req.Songs))
		idSeen := map[string]bool{}
		for _, item := range req.Songs {
			item.Source = strings.TrimSpace(item.Source)
			item.SongID = strings.TrimSpace(item.SongID)
			if item.Source == "" || item.SongID == "" {
				continue
			}
			key := favoritePairKey(item.Source, item.SongID)
			if seen[key] {
				continue
			}
			seen[key] = true
			items = append(items, item)
			if !sourceSeen[item.Source] {
				sourceSeen[item.Source] = true
				sources = append(sources, item.Source)
			}
			if !idSeen[item.SongID] {
				idSeen[item.SongID] = true
				ids = append(ids, item.SongID)
			}
		}
		if len(items) == 0 {
			c.JSON(http.StatusOK, gin.H{"statuses": []favoriteStatusItem{}})
			return
		}

		fav, err := ensureFavoriteCollection(uid)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "查询收藏状态失败"})
			return
		}

		var saved []SavedSong
		if err := db.Select("song_id", "source").
			Where("collection_id = ? AND source IN ? AND song_id IN ?", fav.ID, sources, ids).
			Find(&saved).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "查询收藏状态失败"})
			return
		}
		favorited := make(map[string]bool, len(saved))
		for _, song := range saved {
			favorited[favoritePairKey(song.Source, song.SongID)] = true
		}
		for i := range items {
			items[i].Favorited = favorited[favoritePairKey(items[i].Source, items[i].SongID)]
		}
		c.JSON(http.StatusOK, gin.H{"statuses": items})
	})

	// 切换收藏:在「我喜欢」中有则删、无则加
	api.POST("/favorites/toggle", func(c *gin.Context) {
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
		fav, err := ensureFavoriteCollection(uid)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取收藏歌单失败"})
			return
		}

		existed, err := isSongFavorited(uid, req.Source, req.SongID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "查询收藏状态失败"})
			return
		}
		if existed {
			if err := db.Where("collection_id = ? AND song_id = ? AND source = ?", fav.ID, req.SongID, req.Source).
				Delete(&SavedSong{}).Error; err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "取消收藏失败"})
				return
			}
			c.JSON(http.StatusOK, gin.H{"favorited": false})
			return
		}

		extraStr := encodeSongExtraWithMetadata(req.Extra, req.Album, req.AlbumID)
		song := SavedSong{
			CollectionID: fav.ID,
			SongID:       req.SongID,
			Source:       req.Source,
			Name:         req.Name,
			Artist:       req.Artist,
			Cover:        req.Cover,
			Duration:     req.Duration,
			Extra:        extraStr,
		}
		if err := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&song).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "收藏失败"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"favorited": true})
	})
}

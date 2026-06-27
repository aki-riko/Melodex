package web

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm/clause"
)

// 用户搜索历史:按 user_id 隔离,每人最多保留 searchHistoryMax 条,
// 同关键词重搜更新时间(去重)。供前端「最近搜索」展示。
const searchHistoryMax = 50

type searchHistoryRow struct {
	ID        uint      `gorm:"primaryKey" json:"-"`
	UserID    uint      `gorm:"uniqueIndex:idx_hist_user_kw;not null" json:"-"`
	Keyword   string    `gorm:"uniqueIndex:idx_hist_user_kw;not null" json:"keyword"`
	Type      string    `json:"type"`
	UpdatedAt time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

// recordSearchHistory 记一条搜索历史(去重:同用户同关键词更新时间)。
// userID=0(未登录/桌面异常)跳过。超过上限时删最旧的。
func recordSearchHistory(userID uint, keyword, searchType string) {
	keyword = strings.TrimSpace(keyword)
	if db == nil || userID == 0 || keyword == "" {
		return
	}
	// 链接搜索不入历史(没意义)。
	if strings.HasPrefix(keyword, "http") {
		return
	}
	row := searchHistoryRow{UserID: userID, Keyword: keyword, Type: strings.TrimSpace(searchType), UpdatedAt: time.Now()}
	if err := db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}, {Name: "keyword"}},
		DoUpdates: clause.AssignmentColumns([]string{"type", "updated_at"}),
	}).Create(&row).Error; err != nil {
		return
	}
	pruneSearchHistory(userID)
}

// pruneSearchHistory 保留最近 searchHistoryMax 条,删更旧的。
func pruneSearchHistory(userID uint) {
	var count int64
	if err := db.Model(&searchHistoryRow{}).Where("user_id = ?", userID).Count(&count).Error; err != nil {
		return
	}
	if count <= searchHistoryMax {
		return
	}
	// 找出第 searchHistoryMax 条的时间界,删更旧的。
	var threshold searchHistoryRow
	if err := db.Where("user_id = ?", userID).
		Order("updated_at DESC").
		Offset(searchHistoryMax - 1).Limit(1).
		Find(&threshold).Error; err != nil || threshold.ID == 0 {
		return
	}
	db.Where("user_id = ? AND updated_at < ?", userID, threshold.UpdatedAt).Delete(&searchHistoryRow{})
}

func listSearchHistory(userID uint, limit int) ([]searchHistoryRow, error) {
	if limit <= 0 || limit > searchHistoryMax {
		limit = searchHistoryMax
	}
	var rows []searchHistoryRow
	if userID == 0 {
		return []searchHistoryRow{}, nil
	}
	if err := db.Where("user_id = ?", userID).
		Order("updated_at DESC").Limit(limit).
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// RegisterSearchHistoryRoutes 注册搜索历史接口(userAPI,仅登录,按用户隔离)。
func RegisterSearchHistoryRoutes(api *gin.RouterGroup) {
	api.GET("/search_history", func(c *gin.Context) {
		rows, err := listSearchHistory(currentUserID(c), 0)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "读取搜索历史失败"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"history": rows})
	})

	api.DELETE("/search_history", func(c *gin.Context) {
		uid := currentUserID(c)
		if uid == 0 {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
			return
		}
		kw := strings.TrimSpace(c.Query("keyword"))
		if kw != "" {
			// 删单条。
			db.Where("user_id = ? AND keyword = ?", uid, kw).Delete(&searchHistoryRow{})
		} else {
			// 清空。
			db.Where("user_id = ?", uid).Delete(&searchHistoryRow{})
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
}

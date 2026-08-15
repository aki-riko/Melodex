package web

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func RegisterCollectionRoutes(api *gin.RouterGroup) {
	for _, route := range legacyCollectionPageRoutes {
		api.GET(route, legacyWebPageGone)
	}
	collections := api.Group("/collections")
	registerM3UImport(collections)
	collections.GET("", listCollectionsRoute)
	collections.POST("", createCollectionRoute)
	collections.POST("/import", importCollectionRoute)
	collections.PUT("/:id", updateCollectionRoute)
	collections.DELETE("/:id", deleteCollectionRoute)
	collections.GET("/:id/songs", listCollectionSongsRoute)
	collections.POST("/:id/songs", addCollectionSongRoute)
	collections.DELETE("/:id/songs", deleteCollectionSongsRoute)
}

func listCollectionsRoute(c *gin.Context) {
	var collections []Collection
	query := db.Where("user_id = ?", currentUserID(c)).Order("id DESC")
	if c.Query("include_imported") != "1" {
		query = query.Where(
			"kind = ? OR kind = ? OR kind = '' OR kind IS NULL",
			collectionKindManual, collectionKindFavorite,
		)
	}
	if err := query.Find(&collections).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "获取歌单失败"})
		return
	}
	c.JSON(http.StatusOK, collections)
}

func createCollectionRoute(c *gin.Context) {
	userID := currentUserID(c)
	if userID == 0 {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
		return
	}
	var input Collection
	if err := c.ShouldBindJSON(&input); err != nil || strings.TrimSpace(input.Name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误，必须提供歌单名"})
		return
	}
	collection := Collection{
		UserID: userID, Name: strings.TrimSpace(input.Name),
		Description: strings.TrimSpace(input.Description), Cover: strings.TrimSpace(input.Cover),
		Kind: collectionKindManual, ContentType: collectionContentPlaylist, Source: localMusicSource,
	}
	if err := db.Create(&collection).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "创建失败: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": collection.ID, "name": collection.Name})
}

func importCollectionRoute(c *gin.Context) {
	userID := currentUserID(c)
	if userID == 0 {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
		return
	}
	var request importCollectionRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
		return
	}
	collection, err := buildImportedCollection(request)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	collection.UserID = userID
	if request.MergeIntoID > 0 {
		mergeImportedCollectionRoute(c, collection, request.MergeIntoID)
		return
	}

	existing, err := findImportedCollection(userID, collection)
	if err == nil {
		c.JSON(http.StatusOK, gin.H{"id": existing.ID, "name": existing.Name, "duplicate": true})
		return
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "导入失败: " + err.Error()})
		return
	}
	if err := db.Create(collection).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "导入失败: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": collection.ID, "name": collection.Name})
}

func mergeImportedCollectionRoute(c *gin.Context, imported *Collection, targetID uint) {
	target, err := loadOwnedCollection(fmt.Sprint(targetID), currentUserID(c))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "合并目标歌单不存在"})
		return
	}
	if target.isImported() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "外部导入歌单/专辑不保存歌曲明细，不能作为合并目标"})
		return
	}
	tracks, err := loadImportedCollectionSongs(imported)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "读取平台歌单失败: " + err.Error()})
		return
	}
	added, err := saveSongsToManualCollection(target.ID, tracks)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "合并失败: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"id": target.ID, "name": target.Name, "merged": true,
		"added": added, "total": len(tracks),
	})
}

func findImportedCollection(userID uint, imported *Collection) (*Collection, error) {
	var existing Collection
	err := db.Where(
		"user_id = ? AND kind = ? AND content_type = ? AND source = ? AND external_id = ?",
		userID, collectionKindImported, imported.ContentType, imported.Source, imported.ExternalID,
	).First(&existing).Error
	return &existing, err
}

func updateCollectionRoute(c *gin.Context) {
	collection, ok := writableCollectionForRoute(c, "外部导入歌单/专辑不支持编辑，请删除后重新导入")
	if !ok {
		return
	}
	var input Collection
	if err := c.ShouldBindJSON(&input); err != nil || strings.TrimSpace(input.Name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
		return
	}
	updates := map[string]interface{}{
		"name":        strings.TrimSpace(input.Name),
		"description": strings.TrimSpace(input.Description),
		"cover":       strings.TrimSpace(input.Cover),
	}
	if err := db.Model(&Collection{}).
		Where("id = ? AND user_id = ?", collection.ID, collection.UserID).
		Updates(updates).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "更新失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func deleteCollectionRoute(c *gin.Context) {
	collection, err := loadOwnedCollection(c.Param("id"), currentUserID(c))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "歌单不存在"})
		return
	}
	if collection.normalizedKind() == collectionKindFavorite {
		c.JSON(http.StatusBadRequest, gin.H{"error": "「我喜欢」歌单不可删除"})
		return
	}
	if err := db.Where("user_id = ?", collection.UserID).Delete(&Collection{}, collection.ID).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func listCollectionSongsRoute(c *gin.Context) {
	collection, err := loadOwnedCollection(c.Param("id"), currentUserID(c))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "歌单不存在"})
		return
	}
	songs, err := collectionSongsJSON(collection)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "获取歌曲失败: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, songs)
}

type collectionSongInput struct {
	SongID   string      `json:"id" binding:"required"`
	Source   string      `json:"source" binding:"required"`
	Name     string      `json:"name"`
	Artist   string      `json:"artist"`
	Album    string      `json:"album"`
	AlbumID  string      `json:"album_id"`
	Cover    string      `json:"cover"`
	Duration int         `json:"duration"`
	Extra    interface{} `json:"extra"`
}

func addCollectionSongRoute(c *gin.Context) {
	collection, ok := writableCollectionForRoute(c, "外部导入歌单/专辑不保存歌曲明细，不能直接加入歌曲")
	if !ok {
		return
	}
	var input collectionSongInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误，缺少 id 或 source"})
		return
	}
	_, err := saveSongToManualCollection(collection.ID, model.Track{
		ID: input.SongID, Source: input.Source, Name: input.Name, Artist: input.Artist,
		Album: input.Album, AlbumID: input.AlbumID, Cover: input.Cover,
		Duration: input.Duration,
		Extra:    decodeSongExtraMap(encodeSongExtraWithMetadata(input.Extra, input.Album, input.AlbumID)),
	})
	if err != nil {
		if strings.Contains(err.Error(), "missing song id or source") {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误，缺少 id 或 source"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "添加失败: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

type collectionSongDeleteInput struct {
	Songs []struct {
		SongID string `json:"id"`
		Source string `json:"source"`
	} `json:"songs"`
}

var errInvalidBatchCollectionDelete = errors.New("批量取消收藏需要提供每首歌的 id 和 source")

func deleteCollectionSongsRoute(c *gin.Context) {
	collection, ok := writableCollectionForRoute(c, "外部导入歌单/专辑没有本地歌曲明细可删除")
	if !ok {
		return
	}
	var input collectionSongDeleteInput
	if strings.Contains(c.GetHeader("Content-Type"), "application/json") && c.Request.ContentLength != 0 {
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请求体格式错误"})
			return
		}
	}
	if len(input.Songs) > 0 {
		if err := deleteCollectionSongBatch(collection.ID, input); err != nil {
			if errors.Is(err, errInvalidBatchCollectionDelete) {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			} else {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败"})
			}
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
		return
	}
	songID := strings.TrimSpace(c.Query("id"))
	source := strings.TrimSpace(c.Query("source"))
	if songID == "" || source == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "需要通过 query 传递 id 和 source"})
		return
	}
	if err := deleteSavedSong(db, collection.ID, songID, source); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func writableCollectionForRoute(c *gin.Context, importedMessage string) (*Collection, bool) {
	collection, err := loadOwnedCollection(c.Param("id"), currentUserID(c))
	switch {
	case err != nil || collection == nil:
		c.JSON(http.StatusNotFound, gin.H{"error": "歌单不存在"})
		return nil, false
	case collection.isImported():
		c.JSON(http.StatusBadRequest, gin.H{"error": importedMessage})
		return nil, false
	default:
		return collection, true
	}
}

func deleteCollectionSongBatch(collectionID uint, input collectionSongDeleteInput) error {
	return db.Transaction(func(tx *gorm.DB) error {
		for _, song := range input.Songs {
			songID := strings.TrimSpace(song.SongID)
			source := strings.TrimSpace(song.Source)
			if songID == "" || source == "" {
				return errInvalidBatchCollectionDelete
			}
			if err := deleteSavedSong(tx, collectionID, songID, source); err != nil {
				return err
			}
		}
		return nil
	})
}

func deleteSavedSong(connection *gorm.DB, collectionID uint, songID, source string) error {
	return connection.Where(
		"collection_id = ? AND song_id = ? AND source = ?",
		collectionID, songID, source,
	).Delete(&SavedSong{}).Error
}

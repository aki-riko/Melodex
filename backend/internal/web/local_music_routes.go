package web

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm/clause"
)

func RegisterLocalMusicRoutes(api *gin.RouterGroup) {
	for _, route := range legacyLocalMusicPageRoutes {
		api.GET(route, legacyWebPageGone)
	}
	api.GET("/local_music", listLocalMusicRoute)
	api.DELETE("/local_music", deleteLocalMusicRoute)
	api.GET("/downloads", listDownloadStatusRoute)
	api.GET("/local_music/cover", localMusicCoverRoute)
	api.POST("/local_music/cover", localMusicCoverRoute)
	api.POST("/local_music/upload", uploadLocalMusicRoute)
	api.POST("/collections/:id/local_music", addLocalMusicToCollectionRoute)
}

func listLocalMusicRoute(c *gin.Context) {
	force := c.Query("refresh") == "1" || c.Query("force") == "1"
	tracks, dir, exists, err, refreshing, scannedAt := scanLocalMusicTracksCached(force)
	if err != nil {
		log.Printf("[local_music] scan failed: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "扫描本地音乐失败"})
		return
	}
	tracks = filterLocalTracksForUser(tracks, currentUserID(c), currentUserIsAdmin(c))
	offset := parseLocalMusicRangeInt(c.Query("offset"), 0)
	limit := parseLocalMusicRangeInt(c.Query("limit"), 0)
	page := paginateLocalMusicTracks(tracks, offset, limit)
	markAlreadyAddedLocalTracks(c.Query("collection_id"), currentUserID(c), page)
	c.JSON(http.StatusOK, gin.H{
		"download_dir": filepath.ToSlash(dir), "exists": exists,
		"tracks": page, "total": len(tracks), "offset": offset, "limit": limit,
		"has_more": offset+len(page) < len(tracks), "refreshing": refreshing,
		"scanned_at": scannedAt,
	})
}

func listDownloadStatusRoute(c *gin.Context) {
	downloads, err := existingDownloadStatusForUser(
		currentUserID(c), currentUserIsAdmin(c), localMusicDownloadDir(),
	)
	if err != nil {
		log.Printf("[downloads] query failed user=%d: %v", currentUserID(c), err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "读取已下载列表失败"})
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"downloads": downloads, "total": len(downloads)})
}

func localMusicCoverRoute(c *gin.Context) {
	track, err := localMusicTrackByID(c.Query("id"))
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	allowed, err := localMusicReadAllowed(c, track)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	if !allowed {
		c.Status(http.StatusNotFound)
		return
	}
	saveToServer := wantsSaveLocal(c)
	if saveToServer && !allowSaveLocalRequest(c) {
		return
	}
	data, mimeType, ext, err := readLocalMusicCover(track)
	if err != nil || len(data) == 0 {
		c.Status(http.StatusNotFound)
		return
	}
	filename := localMusicCoverFilename(track, ext)
	if saveToServer {
		saveWebAssetResponse(c, filename, data)
		return
	}
	if c.Query("download") == "1" {
		setDownloadHeader(c, filename)
	}
	c.Header("Cache-Control", "private, max-age=21600")
	c.Data(http.StatusOK, mimeType, data)
}

func uploadLocalMusicRoute(c *gin.Context) {
	limitRequestBody(c, localMusicMaxUploadRequestBytes)
	file, err := c.FormFile("file")
	if err != nil {
		if isRequestBodyTooLarge(err) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "文件过大,单个上传上限 200MB"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "请选择要上传的音乐文件"})
		return
	}
	if file.Size > localMusicMaxUploadBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "文件过大,单个上传上限 200MB"})
		return
	}
	track, err := saveUploadedLocalMusic(file)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := recordDownload(
		currentUserID(c), track.RelPath, localMusicSource,
		track.ID, track.Name, track.Artist,
	); err != nil {
		if removeErr := os.Remove(track.absPath); removeErr != nil {
			log.Printf("[upload] ownership failed and rollback failed path=%q: %v", track.absPath, removeErr)
		}
		invalidateLocalMusicScanCache()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "登记上传归属失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok", "track": track})
}

func deleteLocalMusicRoute(c *gin.Context) {
	if err := deleteLocalMusicTrackForUser(
		c.Query("id"), currentUserID(c), currentUserIsAdmin(c),
	); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func addLocalMusicToCollectionRoute(c *gin.Context) {
	collection, err := loadOwnedCollection(c.Param("id"), currentUserID(c))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "歌单不存在"})
		return
	}
	if collection.isImported() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "外部导入歌单/专辑不支持直接添加本地音乐"})
		return
	}
	var request struct {
		ID string `json:"id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少本地音乐 ID"})
		return
	}
	track, err := localMusicTrackByID(strings.TrimSpace(request.ID))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "本地音乐不存在或已不在下载目录内"})
		return
	}
	allowed, err := localMusicReadAllowed(c, track)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "读取下载归属失败"})
		return
	}
	if !allowed {
		c.JSON(http.StatusNotFound, gin.H{"error": "本地音乐不存在或已不在下载目录内"})
		return
	}
	extra, err := json.Marshal(track.Extra)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "本地音乐元数据无效"})
		return
	}
	song := SavedSong{
		CollectionID: collection.ID, SongID: track.ID, Source: localMusicSource,
		Extra: string(extra), Name: track.Name, Artist: track.Artist,
		Cover: track.Cover, Duration: track.Duration, AddedAt: time.Now(),
	}
	result := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&song)
	if result.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "添加失败: " + result.Error.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"status": "ok", "duplicate": result.RowsAffected == 0, "song": song,
	})
}

package web

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/fileutil"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/gin-gonic/gin"
)

type mediaDownloadRequest struct {
	track          *model.Track
	stream         bool
	embedMetadata  bool
	saveToServer   bool
	requestedRange string
}

func filterAvailableSources(requested, supported []string) []string {
	allowed := make(map[string]struct{}, len(supported))
	for _, source := range supported {
		if source = strings.TrimSpace(source); source != "" {
			allowed[source] = struct{}{}
		}
	}
	selected := make([]string, 0, len(requested))
	seen := make(map[string]struct{})
	for _, source := range requested {
		source = strings.TrimSpace(source)
		_, supported := allowed[source]
		_, duplicate := seen[source]
		if source == "" || !supported || duplicate {
			continue
		}
		seen[source] = struct{}{}
		selected = append(selected, source)
	}
	if len(selected) == 0 {
		return append([]string(nil), supported...)
	}
	return selected
}

func RegisterMusicRoutes(api *gin.RouterGroup) {
	registerPlaybackSegmentRoute(api)
	for _, route := range legacyMusicPageRoutes {
		api.GET(route, legacyWebPageGone)
	}
	api.GET("/inspect", inspectTrackRoute)
	api.GET("/switch_source", switchSourceRoute)
	api.GET("/download", downloadTrackRoute)
	api.POST("/download", downloadTrackRoute)
	api.GET("/download_lrc", rateLimitMiddleware(searchRateLimiter), downloadLyricRoute)
	api.POST("/download_lrc", rateLimitMiddleware(searchRateLimiter), downloadLyricRoute)
	api.GET("/download_cover", downloadCoverRoute)
	api.POST("/download_cover", downloadCoverRoute)
	api.GET("/cover_proxy", coverProxyRoute)
	api.GET("/lyric", rateLimitMiddleware(searchRateLimiter), lyricRoute)
}

func inspectTrackRoute(c *gin.Context) {
	track := trackFromQuery(c)
	if isLocalMusicSource(track.Source) {
		localTrack, err := localMusicTrackByID(track.ID)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"valid": false})
			return
		}
		allowed, err := localMusicReadAllowed(c, localTrack)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "读取下载归属失败"})
			return
		}
		if !allowed {
			c.JSON(http.StatusOK, gin.H{"valid": false})
			return
		}
		payload, _ := inspectLocalMusicFile(track.ID, c.Query("duration"))
		c.JSON(http.StatusOK, payload)
		return
	}
	result := inspectSongQualityCached(*track, track.Duration)
	c.JSON(http.StatusOK, qualityResultPayload(result))
}

func switchSourceRoute(c *gin.Context) {
	duration, _ := strconv.Atoi(strings.TrimSpace(c.Query("duration")))
	selected, score, err := findBestSwitchSong(
		strings.TrimSpace(c.Query("name")),
		strings.TrimSpace(c.Query("artist")),
		strings.TrimSpace(c.Query("source")),
		strings.TrimSpace(c.Query("target")),
		duration,
	)
	if err != nil {
		status := http.StatusNotFound
		if strings.TrimSpace(c.Query("name")) == "" {
			status = http.StatusBadRequest
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"id": selected.ID, "name": selected.Name, "artist": selected.Artist,
		"album": selected.Album, "album_id": selected.AlbumID, "duration": selected.Duration,
		"source": selected.Source, "cover": selected.Cover, "extra": selected.Extra,
		"score": score, "link": selected.Link,
	})
}

func downloadTrackRoute(c *gin.Context) {
	request, err := parseMediaDownloadRequest(c)
	if err != nil {
		c.String(http.StatusBadRequest, err.Error())
		return
	}
	if wantsSaveLocal(c) && !allowSaveLocalRequest(c) {
		return
	}
	if isLocalMusicSource(request.track.Source) {
		serveLocalMusicDownload(c, request.track.ID, request.saveToServer)
		return
	}
	if request.stream && serveOwnedServerCopy(c, request.track) {
		return
	}
	settings := core.GetWebSettings()
	switch {
	case request.saveToServer:
		saveTrackToServer(c, request.track, settings, request.embedMetadata)
	case request.embedMetadata:
		serveEmbeddedTrack(c, request.track, settings)
	case request.track.Source == "soda":
		serveSodaTrack(c, request, settings)
	default:
		serveProviderTrack(c, request, settings)
	}
}

func parseMediaDownloadRequest(c *gin.Context) (mediaDownloadRequest, error) {
	track := trackFromQuery(c)
	if track.ID == "" || track.Source == "" {
		return mediaDownloadRequest{}, errorsNewMissingMediaParams()
	}
	if track.Name == "" {
		track.Name = "Unknown"
	}
	if track.Artist == "" {
		track.Artist = "Unknown"
	}
	stream := c.Query("stream") == "1"
	rangeHeader := strings.TrimSpace(c.GetHeader("Range"))
	withoutRange := rangeHeader == ""
	return mediaDownloadRequest{
		track:          track,
		stream:         stream,
		embedMetadata:  !stream && withoutRange && c.Query("embed") == "1",
		saveToServer:   !stream && withoutRange && wantsSaveLocal(c),
		requestedRange: rangeHeader,
	}, nil
}

func errorsNewMissingMediaParams() error {
	return fmt.Errorf("Missing params")
}

func serveOwnedServerCopy(c *gin.Context, track *model.Track) bool {
	relativePath, err := existingDownloadRelPathForPlayback(
		currentUserID(c), currentUserIsAdmin(c), localMusicDownloadDir(),
		track.Source, track.ID, track.Name, track.Artist,
	)
	if err != nil {
		log.Printf("[stream] query server copy user=%d: %v", currentUserID(c), err)
		return false
	}
	if relativePath == "" {
		return false
	}
	c.Header("X-Melodex-Playback-Source", "server")
	serveLocalMusicDownload(c, encodeLocalMusicID(relativePath), false)
	return true
}

func saveTrackToServer(c *gin.Context, track *model.Track, settings core.WebSettings, embed bool) {
	download, err := core.DownloadSongDataWithTemplate(track, embed, embed, settings.DownloadFilenameTemplate)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	unlock := lockServerDownloadIdentity(track.Source, track.ID, track.Name, track.Artist)
	defer unlock()
	conflict, err := hasConflictingDownloadIdentity(settings.DownloadDir, track.Source, track.ID, track.Name, track.Artist)
	if err != nil {
		log.Printf("[download] inspect identity conflict source=%q id=%q: %v", track.Source, track.ID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "检查同名版本冲突失败"})
		return
	}
	if conflict {
		download.Filename = core.BuildDownloadFilename(track, download.Ext, filenameTemplateWithSongIdentity(settings.DownloadFilenameTemplate))
	}
	download, err = core.SaveDownloadedSongDataToFile(download, settings.DownloadDir)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	relativePath := relPathUnderDir(settings.DownloadDir, download.SavedPath)
	for _, removedPath := range download.RemovedPaths {
		oldRelativePath := relPathUnderDir(settings.DownloadDir, removedPath)
		if oldRelativePath == "" {
			continue
		}
		if err := moveDownloadRecordsToPath(oldRelativePath, relativePath); err != nil {
			log.Printf("[download] migrate ownership old=%q new=%q: %v", oldRelativePath, relativePath, err)
		}
	}
	userID := currentUserID(c)
	recorded := false
	if relativePath != "" && userID > 0 {
		if err := recordDownload(userID, relativePath, track.Source, track.ID, track.Name, track.Artist); err != nil {
			log.Printf("[download] record ownership user=%d rel=%q: %v", userID, relativePath, err)
		} else {
			recorded = true
		}
	}
	invalidateLocalMusicScanCache()
	recordedUserID := uint(0)
	if recorded {
		recordedUserID = userID
	}
	payload := gin.H{
		"status": "ok", "saved": true, "recorded": recorded,
		"recorded_user_id": recordedUserID, "path": download.SavedPath, "filename": download.Filename,
	}
	if download.Warning != "" {
		payload["warning"] = download.Warning
	}
	c.JSON(http.StatusOK, payload)
}

func serveEmbeddedTrack(c *gin.Context, track *model.Track, settings core.WebSettings) {
	download, err := core.DownloadSongDataWithTemplate(track, true, true, settings.DownloadFilenameTemplate)
	if err != nil {
		c.String(http.StatusBadGateway, "Upstream stream error")
		return
	}
	if download.Warning != "" {
		c.Header("X-MusicDL-Warning", download.Warning)
	}
	setDownloadHeader(c, download.Filename)
	c.Data(http.StatusOK, download.ContentType, download.Data)
}

func serveSodaTrack(c *gin.Context, request mediaDownloadRequest, settings core.WebSettings) {
	media, err := core.ResolveProviderMedia(request.track)
	if err != nil || media.PlayAuth == "" {
		markQualityCacheInvalid(*request.track)
		c.String(http.StatusBadGateway, "Soda info error")
		return
	}
	upstreamRequest, err := core.BuildSourceRequest(http.MethodGet, media.URL, "soda", "")
	if err != nil {
		c.String(http.StatusBadGateway, "Soda request error")
		return
	}
	response, err := outboundStreamingHTTPClient.Do(upstreamRequest)
	if err != nil {
		c.String(http.StatusBadGateway, "Soda stream error")
		return
	}
	defer response.Body.Close()
	encrypted, err := readLimitedBody(response.Body, maxBufferedAudioBytes)
	if err != nil {
		c.String(http.StatusBadGateway, "Soda response too large")
		return
	}
	decrypted, err := core.DecryptSodaAudio(encrypted, media.PlayAuth)
	if err != nil {
		c.String(http.StatusInternalServerError, "Decrypt failed")
		return
	}
	extension := core.DetectAudioExt(decrypted)
	filename := core.BuildDownloadFilename(request.track, extension, settings.DownloadFilenameTemplate)
	if !request.stream {
		setDownloadHeader(c, filename)
	}
	clearWriteDeadline(c)
	http.ServeContent(c.Writer, c.Request, filename, time.Now(), bytes.NewReader(decrypted))
}

func serveProviderTrack(c *gin.Context, request mediaDownloadRequest, settings core.WebSettings) {
	resolve := core.GetDownloadFunc(request.track.Source)
	if resolve == nil {
		c.String(http.StatusBadRequest, "Unknown source")
		return
	}
	mediaURL, err := resolve(request.track)
	if err != nil || strings.TrimSpace(mediaURL) == "" {
		markQualityCacheInvalid(*request.track)
		c.String(http.StatusNotFound, "Failed to get URL")
		return
	}
	if fetch, handled, rangeError := core.NewSourceRangeFetch(mediaURL, request.track.Source, request.requestedRange); handled || rangeError != nil {
		if rangeError != nil {
			markQualityCacheInvalid(*request.track)
			c.String(http.StatusBadGateway, "Upstream range error")
			return
		}
		writeProviderRange(c, request, settings, fetch)
		return
	}
	proxyProviderAudio(c, request, settings, mediaURL)
}

func writeProviderRange(c *gin.Context, request mediaDownloadRequest, settings core.WebSettings, fetch *core.SourceRangeFetch) {
	extension := firstAudioExtension(fetch.Ext, request.track.Ext, "mp3")
	filename := core.BuildDownloadFilename(request.track, extension, settings.DownloadFilenameTemplate)
	if request.stream {
		c.Header("Content-Type", core.AudioMimeByExt(extension))
	} else {
		setDownloadHeader(c, filename)
		c.Header("Content-Type", core.AudioMimeByExt(extension))
	}
	c.Header("Accept-Ranges", "bytes")
	c.Header("Content-Length", strconv.FormatInt(fetch.ContentLength, 10))
	if fetch.ContentRange != "" {
		c.Header("Content-Range", fetch.ContentRange)
	}
	c.Status(fetch.StatusCode)
	if err := fetch.WriteTo(c.Writer); err != nil {
		log.Printf("[download] range transfer source=%q id=%q: %v", request.track.Source, request.track.ID, err)
	}
}

func proxyProviderAudio(c *gin.Context, request mediaDownloadRequest, settings core.WebSettings, mediaURL string) {
	upstreamRequest, err := core.BuildSourceRequest(http.MethodGet, mediaURL, request.track.Source, request.requestedRange)
	if err != nil {
		c.String(http.StatusBadGateway, "Upstream request error")
		return
	}
	response, err := outboundStreamingHTTPClient.Do(upstreamRequest)
	if err != nil {
		markQualityCacheInvalid(*request.track)
		c.String(http.StatusBadGateway, "Upstream stream error")
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusBadRequest {
		markQualityCacheInvalid(*request.track)
		c.String(response.StatusCode, "Upstream stream error")
		return
	}
	copyUpstreamHeaders(c.Writer.Header(), response.Header)
	extension := firstAudioExtension(
		core.DetectAudioExtByContentType(response.Header.Get("Content-Type")),
		audioExtensionFromURL(mediaURL), request.track.Ext, "mp3",
	)
	filename := core.BuildDownloadFilename(request.track, extension, settings.DownloadFilenameTemplate)
	if request.stream {
		contentType := strings.ToLower(strings.TrimSpace(response.Header.Get("Content-Type")))
		if contentType == "" || strings.HasPrefix(contentType, "application/octet-stream") {
			c.Header("Content-Type", core.AudioMimeByExt(extension))
		}
	} else {
		setDownloadHeader(c, filename)
	}
	c.Status(response.StatusCode)
	clearWriteDeadline(c)
	if _, err := io.Copy(c.Writer, response.Body); err != nil {
		log.Printf("[download] proxy transfer source=%q id=%q: %v", request.track.Source, request.track.ID, err)
	}
}

func copyUpstreamHeaders(destination, source http.Header) {
	blocked := map[string]bool{
		"Connection": true, "Transfer-Encoding": true, "Date": true,
		"Access-Control-Allow-Origin": true, "Keep-Alive": true,
		"Proxy-Authenticate": true, "Proxy-Authorization": true,
		"Te": true, "Trailer": true, "Upgrade": true,
	}
	for name, values := range source {
		if blocked[http.CanonicalHeaderKey(name)] {
			continue
		}
		destination[name] = append([]string(nil), values...)
	}
}

func firstAudioExtension(candidates ...string) string {
	for _, extension := range candidates {
		extension = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(extension), "."))
		switch extension {
		case "mp3", "flac", "ogg", "m4a", "wav", "wma", "aac":
			return extension
		}
	}
	return "mp3"
}

func audioExtensionFromURL(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(strings.ToLower(path.Ext(parsed.Path)), ".")
}

func downloadLyricRoute(c *gin.Context) {
	track := trackFromQuery(c)
	saveToServer := wantsSaveLocal(c)
	if saveToServer && !allowSaveLocalRequest(c) {
		return
	}
	if isLocalMusicSource(track.Source) {
		serveLocalMusicLyric(c, track, true, saveToServer)
		return
	}
	lyrics, matched, err := loadLyricWithFallback(track)
	if err != nil || lyrics == "" {
		log.Printf("[lyric] download source=%q id=%q name=%q artist=%q: %v", track.Source, track.ID, track.Name, track.Artist, err)
		c.String(http.StatusNotFound, "Lyric not found")
		return
	}
	setLyricSourceHeaders(c, track, matched)
	lyrics = formatLyricForMode(lyrics, c.DefaultQuery("format", "auto"))
	c.Header("X-Lyric-Format", classifyLyricFormat(lyrics))
	filename := fmt.Sprintf("%s - %s.lrc", track.Name, track.Artist)
	if saveToServer {
		saveWebAssetResponse(c, filename, []byte(lyrics))
		return
	}
	setDownloadHeader(c, filename)
	c.String(http.StatusOK, lyrics)
}

func downloadCoverRoute(c *gin.Context) {
	coverURL := strings.TrimSpace(c.Query("url"))
	if coverURL == "" {
		c.Status(http.StatusBadRequest)
		return
	}
	if err := isPublicHTTPURL(coverURL); err != nil {
		c.Status(http.StatusForbidden)
		return
	}
	saveToServer := wantsSaveLocal(c)
	if saveToServer && !allowSaveLocalRequest(c) {
		return
	}
	data, _, err := core.FetchResourceBytesWithMime(coverURL, strings.TrimSpace(c.Query("source")))
	if err != nil || len(data) == 0 {
		c.Status(http.StatusBadGateway)
		return
	}
	filename := fmt.Sprintf("%s - %s.jpg", c.Query("name"), c.Query("artist"))
	if saveToServer {
		saveWebAssetResponse(c, filename, data)
		return
	}
	setDownloadHeader(c, filename)
	c.Data(http.StatusOK, "image/jpeg", data)
}

func coverProxyRoute(c *gin.Context) {
	coverURL := strings.TrimSpace(c.Query("url"))
	if coverURL == "" {
		c.Status(http.StatusBadRequest)
		return
	}
	if err := isPublicHTTPURL(coverURL); err != nil {
		c.Status(http.StatusForbidden)
		return
	}
	data, contentType, err := loadProxyCover(coverURL, c.Query("source"))
	if err != nil {
		c.Status(http.StatusBadGateway)
		return
	}
	if contentType == "" {
		contentType = "image/jpeg"
	}
	c.Header("Cache-Control", "public, max-age=604800")
	c.Data(http.StatusOK, contentType, data)
}

func loadProxyCover(coverURL, source string) ([]byte, string, error) {
	data, contentType, err := core.GetCachedCover(coverURL, strings.TrimSpace(source))
	if err != nil {
		return nil, "", err
	}
	if len(data) == 0 {
		return nil, "", errors.New("empty cover response")
	}
	return data, contentType, nil
}

func lyricRoute(c *gin.Context) {
	track := trackFromQuery(c)
	if isLocalMusicSource(track.Source) {
		serveLocalMusicLyric(c, track, false)
		return
	}
	lyrics, matched, err := loadLyricWithFallback(track)
	if err != nil || lyrics == "" {
		log.Printf("[lyric] fetch source=%q id=%q name=%q artist=%q: %v", track.Source, track.ID, track.Name, track.Artist, err)
		writeUnavailableLyric(c)
		return
	}
	lyrics = formatLyricForMode(lyrics, c.DefaultQuery("format", "auto"))
	c.Header("X-Lyric-Format", classifyLyricFormat(lyrics))
	setLyricSourceHeaders(c, track, matched)
	c.String(http.StatusOK, lyrics)
}

func writeUnavailableLyric(c *gin.Context) {
	c.String(http.StatusOK, "[00:00.00] 暂无歌词")
}

func setLyricSourceHeaders(c *gin.Context, requested, matched *model.Track) {
	if matched == nil {
		return
	}
	c.Header("X-Lyric-Source", matched.Source)
	if requested != nil && matched.Source != requested.Source {
		c.Header("X-Lyric-Fallback-Source", matched.Source)
	}
}

func saveWebAssetResponse(c *gin.Context, filename string, data []byte) {
	savedPath, savedFilename, err := saveWebAssetToLocal(filename, data)
	if err == nil {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "saved": true, "path": savedPath, "filename": savedFilename})
		return
	}
	c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
}

func saveWebAssetToLocal(filename string, data []byte) (string, string, error) {
	if len(data) == 0 {
		return "", "", fmt.Errorf("empty file data")
	}
	targetDirectory := strings.TrimSpace(core.GetWebSettings().DownloadDir)
	if targetDirectory == "" {
		targetDirectory = core.DefaultWebDownloadDir
	}
	targetDirectory = filepath.Clean(targetDirectory)
	if err := os.MkdirAll(targetDirectory, 0o755); err != nil {
		return "", "", err
	}
	savedFilename := fileutil.SanitizeFilename(strings.TrimSpace(filename))
	if savedFilename == "" {
		savedFilename = "download"
	}
	savedPath := filepath.Join(targetDirectory, savedFilename)
	if err := os.WriteFile(savedPath, data, 0o644); err != nil {
		return "", "", err
	}
	return savedPath, savedFilename, nil
}

func trackFromQuery(c *gin.Context) *model.Track {
	duration, _ := strconv.Atoi(strings.TrimSpace(c.Query("duration")))
	extra := parseSongExtraQuery(c.Query("extra"))
	album := strings.TrimSpace(c.Query("album"))
	if album == "" {
		album = strings.TrimSpace(extra["album"])
	}
	return &model.Track{
		ID: strings.TrimSpace(c.Query("id")), Source: strings.TrimSpace(c.Query("source")),
		Name: strings.TrimSpace(c.Query("name")), Artist: strings.TrimSpace(c.Query("artist")),
		Album: album, Duration: duration, Cover: strings.TrimSpace(c.Query("cover")), Extra: extra,
	}
}

func parseSongExtraQuery(raw string) map[string]string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	var values map[string]any
	if err := decoder.Decode(&values); err != nil {
		return nil
	}
	result := make(map[string]string, len(values))
	for key, value := range values {
		switch typed := value.(type) {
		case string:
			result[key] = typed
		case json.Number:
			result[key] = typed.String()
		case bool:
			result[key] = strconv.FormatBool(typed)
		default:
			if encoded, err := json.Marshal(typed); err == nil {
				result[key] = string(encoded)
			}
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

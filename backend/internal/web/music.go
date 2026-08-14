package web

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/fileutil"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/gin-gonic/gin"
)

func filterAvailableSources(requested, supported []string) []string {
	allowed := make(map[string]bool, len(supported))
	for _, source := range supported {
		allowed[strings.TrimSpace(source)] = true
	}
	seen := make(map[string]bool)
	result := make([]string, 0, len(requested))
	for _, source := range requested {
		source = strings.TrimSpace(source)
		if source == "" || !allowed[source] || seen[source] {
			continue
		}
		seen[source] = true
		result = append(result, source)
	}
	if len(result) == 0 {
		return append([]string(nil), supported...)
	}
	return result
}

func RegisterMusicRoutes(api *gin.RouterGroup) {
	registerPlaybackSegmentRoute(api)

	for _, route := range legacyMusicPageRoutes {
		api.GET(route, legacyWebPageGone)
	}

	api.GET("/inspect", func(c *gin.Context) {
		id := c.Query("id")
		src := c.Query("source")
		durStr := c.Query("duration")
		extra := parseSongExtraQuery(c.Query("extra"))

		if isLocalMusicSource(src) {
			payload, _ := inspectLocalMusicFile(id, durStr)
			c.JSON(200, payload)
			return
		}

		duration, _ := strconv.Atoi(durStr)
		result := inspectSongQualityCached(model.Track{ID: id, Source: src, Duration: duration, Extra: extra}, duration)
		c.JSON(200, qualityResultPayload(result))
	})

	api.GET("/switch_source", func(c *gin.Context) {
		name := strings.TrimSpace(c.Query("name"))
		artist := strings.TrimSpace(c.Query("artist"))
		current := strings.TrimSpace(c.Query("source"))
		target := strings.TrimSpace(c.Query("target"))
		durationStr := strings.TrimSpace(c.Query("duration"))

		origDuration, _ := strconv.Atoi(durationStr)

		if name == "" {
			c.JSON(400, gin.H{"error": "missing name"})
			return
		}

		selected, selectedScore, err := findBestSwitchSong(name, artist, current, target, origDuration)
		if err != nil {
			c.JSON(404, gin.H{"error": err.Error()})
			return
		}

		c.JSON(200, gin.H{
			"id":       selected.ID,
			"name":     selected.Name,
			"artist":   selected.Artist,
			"album":    selected.Album,
			"album_id": selected.AlbumID,
			"duration": selected.Duration,
			"source":   selected.Source,
			"cover":    selected.Cover,
			"extra":    selected.Extra,
			"score":    selectedScore,
			"link":     selected.Link,
		})
	})

	downloadHandler := func(c *gin.Context) {
		id := c.Query("id")
		source := c.Query("source")
		name := c.Query("name")
		artist := c.Query("artist")
		album := strings.TrimSpace(c.Query("album"))
		duration, _ := strconv.Atoi(strings.TrimSpace(c.Query("duration")))
		coverURL := strings.TrimSpace(c.Query("cover"))
		streamPlayback := c.Query("stream") == "1"
		noRangeRequest := strings.TrimSpace(c.GetHeader("Range")) == ""
		embedMeta := !streamPlayback && c.Query("embed") == "1" && noRangeRequest
		saveLocal := !streamPlayback && noRangeRequest && wantsSaveLocal(c)
		if wantsSaveLocal(c) && !allowSaveLocalRequest(c) {
			return
		}
		extra := parseSongExtraQuery(c.Query("extra"))
		if album == "" && extra != nil {
			album = strings.TrimSpace(extra["album"])
		}

		if id == "" || source == "" {
			c.String(400, "Missing params")
			return
		}
		if name == "" {
			name = "Unknown"
		}
		if artist == "" {
			artist = "Unknown"
		}

		if isLocalMusicSource(source) {
			serveLocalMusicDownload(c, id, saveLocal)
			return
		}

		settings := core.GetWebSettings()
		tempSong := &model.Track{ID: id, Source: source, Name: name, Artist: artist, Album: album, Duration: duration, Cover: coverURL, Extra: extra}

		// Web 播放本地优先:只要当前用户的“服务器”状态能命中真实文件,
		// 就直接从 NAS 发流,不再依赖可能已失效的 QQ/网易/酷我等在线地址。
		// 仅拦截 stream=1;显式下载/音质升级仍走原下载链路。
		if streamPlayback {
			rel, resolveErr := existingDownloadRelPathForPlayback(
				currentUserID(c),
				currentUserIsAdmin(c),
				localMusicDownloadDir(),
				source,
				id,
				name,
				artist,
			)
			if resolveErr != nil {
				log.Printf("[stream] 查询服务器副本失败 user=%d: %v", currentUserID(c), resolveErr)
			} else if rel != "" {
				c.Header("X-Melodex-Playback-Source", "server")
				serveLocalMusicDownload(c, encodeLocalMusicID(rel), false)
				return
			}
		}

		if saveLocal {
			result, err := core.DownloadSongDataWithTemplate(tempSong, embedMeta, embedMeta, settings.DownloadFilenameTemplate)
			if err != nil {
				c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
				return
			}

			// 下载本身并发执行；只在落盘与登记阶段按“歌名+歌手”串行化。
			// 这样同名不同 ID 的原唱/伴奏即使并发完成，也能让后到者看到前一条记录，
			// 自动使用带 source+id 的独立文件名，避免覆盖。
			unlockIdentity := lockServerDownloadIdentity(source, id, name, artist)
			defer unlockIdentity()
			conflict, conflictErr := hasConflictingDownloadIdentity(settings.DownloadDir, source, id, name, artist)
			if conflictErr != nil {
				log.Printf("[download] 检查同名版本冲突失败 source=%q id=%q: %v", source, id, conflictErr)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "检查同名版本冲突失败"})
				return
			}
			if conflict {
				result.Filename = core.BuildDownloadFilename(tempSong, result.Ext, filenameTemplateWithSongIdentity(settings.DownloadFilenameTemplate))
			}
			result, err = core.SaveDownloadedSongDataToFile(result, settings.DownloadDir)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}

			savedRel := relPathUnderDir(settings.DownloadDir, result.SavedPath)

			// 音质升级时删除了同名低音质旧文件,把所有用户的归属迁移到新文件。
			// 不能直接删除旧路径记录:共享旧文件的其他用户也应继续看到升级后的版本。
			for _, removed := range result.RemovedPaths {
				if rel := relPathUnderDir(settings.DownloadDir, removed); rel != "" {
					if err := moveDownloadRecordsToPath(rel, savedRel); err != nil {
						log.Printf("[download] 迁移旧音质归属记录失败 old=%q new=%q: %v", rel, savedRel, err)
					}
				}
			}

			// 登记下载归属(共享目录 + 归属表方案):本地库据此按用户隔离。
			// userID=0(桌面模式异常/未登录)时 recordDownload 内部跳过,不影响下载本身。
			// 跳过或正常写入都要登记:即便复用已存在文件,当前用户也应获得归属。
			userID := currentUserID(c)
			recorded := false
			if savedRel != "" && userID > 0 {
				if err := recordDownload(userID, savedRel, source, id, name, artist); err != nil {
					log.Printf("[download] 登记下载归属失败 user=%d rel=%q: %v", userID, savedRel, err)
				} else {
					recorded = true
				}
			}
			// 下载目录已变化,让“已下载”页面下次进入时同步扫描真实文件,
			// 避免 stale-while-revalidate 快照导致刚下载的歌要刷新两次才出现。
			invalidateLocalMusicScanCache()
			recordedUserID := uint(0)
			if recorded {
				recordedUserID = userID
			}

			payload := gin.H{
				"status":           "ok",
				"saved":            true,
				"recorded":         recorded,
				"recorded_user_id": recordedUserID,
				"path":             result.SavedPath,
				"filename":         result.Filename,
			}
			if result.Warning != "" {
				payload["warning"] = result.Warning
			}
			c.JSON(200, payload)
			return
		}

		if embedMeta {
			result, err := core.DownloadSongDataWithTemplate(tempSong, true, true, settings.DownloadFilenameTemplate)
			if err != nil {
				c.String(502, "Upstream stream error")
				return
			}
			if result.Warning != "" {
				c.Header("X-MusicDL-Warning", result.Warning)
			}

			setDownloadHeader(c, result.Filename)
			c.Data(200, result.ContentType, result.Data)
			return
		}

		if source == "soda" {
			media, err := core.ResolveProviderMedia(tempSong)
			if err != nil {
				markQualityCacheInvalid(*tempSong)
				c.String(502, "Soda info error")
				return
			}
			if media.PlayAuth == "" {
				c.String(502, "Soda auth error")
				return
			}
			req, reqErr := core.BuildSourceRequest("GET", media.URL, "soda", "")
			if reqErr != nil {
				c.String(502, "Soda request error")
				return
			}
			resp, err := outboundStreamingHTTPClient.Do(req)
			if err != nil {
				c.String(502, "Soda stream error")
				return
			}
			defer resp.Body.Close()
			encryptedData, readErr := readLimitedBody(resp.Body, maxBufferedAudioBytes)
			if readErr != nil {
				c.String(502, "Soda response too large")
				return
			}
			finalData, err := core.DecryptSodaAudio(encryptedData, media.PlayAuth)
			if err != nil {
				c.String(500, "Decrypt failed")
				return
			}
			ext := core.DetectAudioExt(finalData)
			filename := core.BuildDownloadFilename(tempSong, ext, settings.DownloadFilenameTemplate)
			if !streamPlayback {
				setDownloadHeader(c, filename)
			}
			// 音频写出(慢速客户端拉全曲可能超 30s),解除全局 WriteTimeout。
			clearWriteDeadline(c)
			http.ServeContent(c.Writer, c.Request, filename, time.Now(), bytes.NewReader(finalData))
			return
		}

		dlFunc := core.GetDownloadFunc(source)
		if dlFunc == nil {
			c.String(400, "Unknown source")
			return
		}

		downloadUrl, err := dlFunc(tempSong)
		if err != nil {
			markQualityCacheInvalid(*tempSong)
			c.String(404, "Failed to get URL")
			return
		}

		if rangeFetch, handled, rangeErr := core.NewSourceRangeFetch(downloadUrl, source, c.GetHeader("Range")); rangeErr != nil {
			markQualityCacheInvalid(*tempSong)
			c.String(502, "Upstream range error")
			return
		} else if handled {
			ext := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(rangeFetch.Ext, ".")))
			if ext == "" {
				ext = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(tempSong.Ext, ".")))
			}
			if ext == "" {
				ext = "mp3"
			}

			filename := core.BuildDownloadFilename(tempSong, ext, settings.DownloadFilenameTemplate)
			if streamPlayback {
				c.Header("Content-Type", core.AudioMimeByExt(ext))
			} else {
				setDownloadHeader(c, filename)
				c.Header("Content-Type", core.AudioMimeByExt(ext))
			}
			c.Header("Accept-Ranges", "bytes")
			c.Header("Content-Length", strconv.FormatInt(rangeFetch.ContentLength, 10))
			if rangeFetch.ContentRange != "" {
				c.Header("Content-Range", rangeFetch.ContentRange)
			}
			c.Status(rangeFetch.StatusCode)
			if err := rangeFetch.WriteTo(c.Writer); err != nil {
				return
			}
			return
		}

		req, reqErr := core.BuildSourceRequest("GET", downloadUrl, source, c.GetHeader("Range"))
		if reqErr != nil {
			c.String(502, "Upstream request error")
			return
		}

		resp, err := outboundStreamingHTTPClient.Do(req)
		if err != nil {
			markQualityCacheInvalid(*tempSong)
			c.String(502, "Upstream stream error")
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode >= http.StatusBadRequest {
			markQualityCacheInvalid(*tempSong)
			c.String(resp.StatusCode, "Upstream stream error")
			return
		}

		for k, v := range resp.Header {
			if k != "Transfer-Encoding" && k != "Date" && k != "Access-Control-Allow-Origin" {
				c.Writer.Header()[k] = v
			}
		}

		ext := core.DetectAudioExtByContentType(resp.Header.Get("Content-Type"))
		if ext == "" {
			if parsedURL, parseErr := url.Parse(downloadUrl); parseErr == nil {
				suffix := strings.ToLower(strings.TrimPrefix(path.Ext(parsedURL.Path), "."))
				switch suffix {
				case "mp3", "flac", "ogg", "m4a":
					ext = suffix
				}
			}
		}
		if ext == "" {
			ext = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(tempSong.Ext, ".")))
		}
		if ext == "" {
			ext = "mp3"
		}

		filename := core.BuildDownloadFilename(tempSong, ext, settings.DownloadFilenameTemplate)
		if streamPlayback {
			contentType := strings.TrimSpace(strings.ToLower(resp.Header.Get("Content-Type")))
			if contentType == "" || strings.HasPrefix(contentType, "application/octet-stream") {
				c.Header("Content-Type", core.AudioMimeByExt(ext))
			}
		} else {
			setDownloadHeader(c, filename)
		}
		c.Status(resp.StatusCode)
		// 下载/流播放时长不可预期(大文件/长音频),解除全局 WriteTimeout,防被 30s 掐断。
		clearWriteDeadline(c)
		io.Copy(c.Writer, resp.Body)
	}
	api.GET("/download", downloadHandler)
	api.POST("/download", downloadHandler)

	downloadLRCHandler := func(c *gin.Context) {
		song := lyricSongFromQuery(c)
		name := song.Name
		artist := song.Artist
		saveLocal := wantsSaveLocal(c)
		if saveLocal && !allowSaveLocalRequest(c) {
			return
		}

		if isLocalMusicSource(song.Source) {
			serveLocalMusicLyric(c, song, true, saveLocal)
			return
		}

		lrc, matchedSong, err := loadLyricWithFallback(song)
		if err != nil || lrc == "" {
			log.Printf("[lyric] 下载歌词失败 source=%q id=%q name=%q artist=%q: %v", song.Source, song.ID, song.Name, song.Artist, err)
			c.String(404, "Lyric not found")
			return
		}
		if matchedSong != nil {
			c.Header("X-Lyric-Source", matchedSong.Source)
			if matchedSong.Source != song.Source {
				c.Header("X-Lyric-Fallback-Source", matchedSong.Source)
			}
		}
		lrc = formatLyricForMode(lrc, c.DefaultQuery("format", "auto"))
		c.Header("X-Lyric-Format", classifyLyricFormat(lrc))

		filename := fmt.Sprintf("%s - %s.lrc", name, artist)
		if saveLocal {
			saveWebAssetResponse(c, filename, []byte(lrc))
			return
		}
		setDownloadHeader(c, filename)
		c.String(200, lrc)
	}
	api.GET("/download_lrc", rateLimitMiddleware(searchRateLimiter), downloadLRCHandler)
	api.POST("/download_lrc", rateLimitMiddleware(searchRateLimiter), downloadLRCHandler)

	downloadCoverHandler := func(c *gin.Context) {
		u := c.Query("url")
		if u == "" {
			return
		}
		// 防 SSRF:拒绝内网/环回/云元数据等目标,与 cover_proxy 一致。
		if err := isPublicHTTPURL(u); err != nil {
			c.Status(http.StatusForbidden)
			return
		}
		saveLocal := wantsSaveLocal(c)
		if saveLocal && !allowSaveLocalRequest(c) {
			return
		}
		// 用 core.FetchResourceBytesWithMime(带 CheckRedirect SSRF 闭环)而非 utils.Get(跟随重定向不校验)。
		// 封面是图片资源,不能走音频 Range 探测,否则支持 Range 的图片 CDN 会被误判为非音频。
		resp, _, err := core.FetchResourceBytesWithMime(u, c.Query("source"))
		if err == nil {
			filename := fmt.Sprintf("%s - %s.jpg", c.Query("name"), c.Query("artist"))
			if saveLocal {
				saveWebAssetResponse(c, filename, resp)
				return
			}
			setDownloadHeader(c, filename)
			c.Data(200, "image/jpeg", resp)
		}
	}
	api.GET("/download_cover", downloadCoverHandler)
	api.POST("/download_cover", downloadCoverHandler)

	api.GET("/cover_proxy", func(c *gin.Context) {
		u := strings.TrimSpace(c.Query("url"))
		if u == "" {
			c.Status(http.StatusBadRequest)
			return
		}

		// 防 SSRF:拒绝内网/环回/云元数据等目标,避免该公开接口被当作内网探测代理。
		if err := isPublicHTTPURL(u); err != nil {
			c.Status(http.StatusForbidden)
			return
		}

		data, contentType, err := core.GetCachedCover(u, strings.TrimSpace(c.Query("source")))
		if err != nil || len(data) == 0 {
			c.Status(http.StatusBadGateway)
			return
		}
		if contentType == "" {
			contentType = "image/jpeg"
		}

		// 封面不可变,长缓存(7天):浏览器/PWA SW 也能命中,减少 cover_proxy 请求。
		c.Header("Cache-Control", "public, max-age=604800")
		c.Data(http.StatusOK, contentType, data)
	})

	api.GET("/lyric", rateLimitMiddleware(searchRateLimiter), func(c *gin.Context) {
		song := lyricSongFromQuery(c)
		if isLocalMusicSource(song.Source) {
			serveLocalMusicLyric(c, song, false)
			return
		}

		lrc, matchedSong, err := loadLyricWithFallback(song)
		if err == nil && lrc != "" {
			lrc = formatLyricForMode(lrc, c.DefaultQuery("format", "auto"))
			c.Header("X-Lyric-Format", classifyLyricFormat(lrc))
			if matchedSong != nil {
				c.Header("X-Lyric-Source", matchedSong.Source)
				if matchedSong.Source != song.Source {
					c.Header("X-Lyric-Fallback-Source", matchedSong.Source)
				}
			}
			c.String(200, lrc)
			return
		}
		log.Printf("[lyric] 获取歌词失败 source=%q id=%q name=%q artist=%q: %v", song.Source, song.ID, song.Name, song.Artist, err)
		c.String(200, "[00:00.00] 暂无歌词")
	})
}

func saveWebAssetResponse(c *gin.Context, filename string, data []byte) {
	savedPath, savedFilename, err := saveWebAssetToLocal(filename, data)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"status":   "ok",
		"saved":    true,
		"path":     savedPath,
		"filename": savedFilename,
	})
}

func saveWebAssetToLocal(filename string, data []byte) (string, string, error) {
	if len(data) == 0 {
		return "", "", fmt.Errorf("empty file data")
	}
	settings := core.GetWebSettings()
	targetDir := strings.TrimSpace(settings.DownloadDir)
	if targetDir == "" {
		targetDir = core.DefaultWebDownloadDir
	}
	targetDir = filepath.Clean(targetDir)
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return "", "", err
	}
	savedFilename := fileutil.SanitizeFilename(strings.TrimSpace(filename))
	if savedFilename == "" {
		savedFilename = "download"
	}
	savedPath := filepath.Join(targetDir, savedFilename)
	if err := os.WriteFile(savedPath, data, 0644); err != nil {
		return "", "", err
	}
	return savedPath, savedFilename, nil
}

func lyricSongFromQuery(c *gin.Context) *model.Track {
	duration, _ := strconv.Atoi(strings.TrimSpace(c.Query("duration")))
	return &model.Track{
		ID:       strings.TrimSpace(c.Query("id")),
		Source:   strings.TrimSpace(c.Query("source")),
		Name:     strings.TrimSpace(c.Query("name")),
		Artist:   strings.TrimSpace(c.Query("artist")),
		Album:    strings.TrimSpace(c.Query("album")),
		Duration: duration,
		Extra:    parseSongExtraQuery(c.Query("extra")),
	}
}

type switchCandidate struct {
	song    model.Track
	score   float64
	durDiff int
}

type switchSearchResult struct {
	source     string
	candidates []switchCandidate
}

var (
	switchSearchFuncProvider = func(source string) func(string) ([]model.Track, error) {
		return core.GetSearchFunc(source)
	}
	switchValidatePlayable   = core.ValidatePlayable
	switchAllSourceNames     = core.GetAllSourceNames
	switchDefaultSourceNames = core.GetDefaultSourceNames
)

const (
	switchMaxCandidatesPerSource     = 8
	switchSourceSearchTimeout        = 6 * time.Second
	switchHighConfidenceScore        = 0.98
	switchParallelValidationLimit    = 12
	switchParallelValidationParallel = 6
)

func findBestSwitchSong(name string, artist string, current string, target string, origDuration int) (*model.Track, float64, error) {
	name = strings.TrimSpace(name)
	artist = strings.TrimSpace(artist)
	current = strings.TrimSpace(current)
	target = strings.TrimSpace(target)

	if name == "" {
		return nil, 0, fmt.Errorf("missing name")
	}

	keyword := name
	if artist != "" {
		keyword = name + " " + artist
	}

	sources := switchCandidateSources(current, target)
	if len(sources) == 0 {
		return nil, 0, fmt.Errorf("no match")
	}

	var wg sync.WaitGroup
	results := make(chan switchSearchResult, len(sources))
	var candidates []switchCandidate

	for _, src := range sources {
		wg.Add(1)
		go func(s string, f func(string) ([]model.Track, error)) {
			defer wg.Done()
			sourceCandidates := searchSwitchSourceCandidates(s, f, keyword, name, artist, origDuration)
			if len(sourceCandidates) == 0 {
				return
			}
			results <- switchSearchResult{source: s, candidates: sourceCandidates}
		}(src, switchSearchFuncProvider(src))
	}

	go func() {
		wg.Wait()
		close(results)
	}()

	for result := range results {
		candidates = append(candidates, result.candidates...)
		sortSwitchCandidates(result.candidates)
		if len(result.candidates) == 0 {
			continue
		}

		best := result.candidates[0]
		if isHighConfidenceSwitchCandidate(best, origDuration) && switchValidatePlayable(&best.song) {
			tmp := best.song
			return &tmp, best.score, nil
		}
	}

	if len(candidates) == 0 {
		return nil, 0, fmt.Errorf("no match")
	}

	sortSwitchCandidates(candidates)
	if selected, score, ok := validateSwitchCandidates(candidates); ok {
		return selected, score, nil
	}

	return nil, 0, fmt.Errorf("no playable match")
}

func switchCandidateSources(current string, target string) []string {
	current = strings.TrimSpace(current)
	target = strings.TrimSpace(target)
	if target != "" {
		if isSwitchSourceAllowed(target, current) && switchSearchFuncProvider(target) != nil {
			return []string{target}
		}
		return nil
	}

	seen := make(map[string]bool)
	sources := make([]string, 0)
	add := func(source string) {
		source = strings.TrimSpace(source)
		if seen[source] || !isSwitchSourceAllowed(source, current) || switchSearchFuncProvider(source) == nil {
			return
		}
		seen[source] = true
		sources = append(sources, source)
	}

	for _, source := range switchDefaultSourceNames() {
		add(source)
	}
	for _, source := range switchAllSourceNames() {
		add(source)
	}
	return sources
}

func isSwitchSourceAllowed(source string, current string) bool {
	if source == "" || source == current {
		return false
	}
	if source == "soda" || source == "fivesing" {
		return false
	}
	return true
}

func searchSwitchSourceCandidates(source string, fn func(string) ([]model.Track, error), keyword string, name string, artist string, origDuration int) []switchCandidate {
	type searchResponse struct {
		songs []model.Track
		err   error
	}

	callSearch := func(query string) ([]model.Track, error) {
		done := make(chan searchResponse, 1)
		go func() {
			res, err := fn(query)
			done <- searchResponse{songs: res, err: err}
		}()
		select {
		case res := <-done:
			return res.songs, res.err
		case <-time.After(switchSourceSearchTimeout):
			return nil, fmt.Errorf("search timeout")
		}
	}

	res, err := callSearch(keyword)
	if (err != nil || len(res) == 0) && artist != "" {
		res, _ = callSearch(name)
	}
	if len(res) == 0 {
		return nil
	}

	limit := len(res)
	if limit > switchMaxCandidatesPerSource {
		limit = switchMaxCandidatesPerSource
	}

	candidates := make([]switchCandidate, 0, limit)
	for i := 0; i < limit; i++ {
		cand := res[i]
		cand.Source = source
		score := core.CalcSongSimilarity(name, artist, cand.Name, cand.Artist)
		if score <= 0 {
			continue
		}

		durDiff := 0
		if origDuration > 0 && cand.Duration > 0 {
			durDiff = core.IntAbs(origDuration - cand.Duration)
			if !core.IsDurationClose(origDuration, cand.Duration) {
				continue
			}
		}

		candidates = append(candidates, switchCandidate{song: cand, score: score, durDiff: durDiff})
	}

	return candidates
}

func sortSwitchCandidates(candidates []switchCandidate) {
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].score == candidates[j].score {
			return candidates[i].durDiff < candidates[j].durDiff
		}
		return candidates[i].score > candidates[j].score
	})
}

func isHighConfidenceSwitchCandidate(candidate switchCandidate, origDuration int) bool {
	if candidate.score < switchHighConfidenceScore {
		return false
	}
	if origDuration > 0 && candidate.song.Duration > 0 && candidate.durDiff > 3 {
		return false
	}
	return true
}

func validateSwitchCandidates(candidates []switchCandidate) (*model.Track, float64, bool) {
	limit := len(candidates)
	if limit > switchParallelValidationLimit {
		limit = switchParallelValidationLimit
	}
	candidates = candidates[:limit]

	type validationResult struct {
		index int
		valid bool
	}

	parallel := switchParallelValidationParallel
	if parallel > len(candidates) {
		parallel = len(candidates)
	}
	if parallel < 1 {
		parallel = 1
	}

	jobs := make(chan int, len(candidates))
	results := make(chan validationResult, len(candidates))
	var wg sync.WaitGroup
	for worker := 0; worker < parallel; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				results <- validationResult{index: index, valid: switchValidatePlayable(&candidates[index].song)}
			}
		}()
	}

	for index := range candidates {
		jobs <- index
	}
	close(jobs)
	wg.Wait()
	close(results)

	valid := make([]bool, len(candidates))
	for result := range results {
		valid[result.index] = result.valid
	}
	for index, ok := range valid {
		if ok {
			tmp := candidates[index].song
			return &tmp, candidates[index].score, true
		}
	}
	return nil, 0, false
}

func parseSongExtraQuery(raw string) map[string]string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}

	var decoded map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil
	}

	extra := make(map[string]string, len(decoded))
	for key, value := range decoded {
		switch v := value.(type) {
		case string:
			extra[key] = v
		case float64:
			extra[key] = strconv.FormatFloat(v, 'f', 0, 64)
		case bool:
			extra[key] = strconv.FormatBool(v)
		default:
			b, err := json.Marshal(v)
			if err == nil {
				extra[key] = string(b)
			}
		}
	}
	if len(extra) == 0 {
		return nil
	}
	return extra
}

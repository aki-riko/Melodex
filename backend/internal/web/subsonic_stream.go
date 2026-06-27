package web

// Subsonic facade —— stream 端点(本地优先 + 在线播放 + 后台落盘入库)。
//
// stream 是「听 = 下载」的核心:
//  1. 解码 id;本地曲库 id → 直接发本地文件
//  2. 在线源 id → 先查共享下载目录是否已有该曲(按 标题+艺人 匹配)
//     - 已有 → 发本地文件(省流量、秒开)
//     - 没有 → 在线解析反代给客户端播放,同时后台 goroutine 完整下载+刮削落盘
//  3. 后台下载去重:同一首歌在下载中不重复启动(sync.Map 锁 song key)

import (
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/guohuiyuan/go-music-dl/core"
	"github.com/guohuiyuan/music-lib/model"
)

// downloadInFlight 记录正在后台下载的歌曲(key=source\x00id),防重复下载。
var downloadInFlight sync.Map

// subsonicStream 处理 stream/download 端点。
func subsonicStream(c *gin.Context) {
	id := strings.TrimSpace(c.Query("id"))
	if id == "" {
		respondSubsonicError(c, errSubsonicMissingParam)
		return
	}
	log.Printf("[subsonic] stream请求头 Range=%q Accept=%q Conn=%q UA=%q Icy=%q",
		c.GetHeader("Range"), c.GetHeader("Accept"), c.GetHeader("Connection"),
		c.GetHeader("User-Agent"), c.GetHeader("Icy-MetaData"))

	// 本地曲库 id:直接发本地文件。
	if localTrackID, ok := decodeLocalSongID(id); ok {
		track, err := localMusicTrackByID(localTrackID)
		if err != nil {
			respondSubsonicError(c, errSubsonicNotFound)
			return
		}
		serveLocalTrackAbs(c, track)
		return
	}

	// 在线源 id。
	song, ok := decodeOnlineSongID(id)
	if !ok {
		respondSubsonicError(c, errSubsonicNotFound)
		return
	}

	// 1) 先查共享目录是否已下载该曲(听过的会沉淀在这)。
	if track := findDownloadedTrack(song); track != nil {
		log.Printf("[subsonic] stream 命中本地 %s-%s → %s", song.Name, song.Artist, track.Filename)
		serveLocalTrackAbs(c, track)
		return
	}
	log.Printf("[subsonic] stream 未命中本地,走在线 %s-%s (source=%s)", song.Name, song.Artist, song.Source)

	// 2) 未下载:在线反代播放 + 后台完整下载入库。
	streamOnlineAndCache(c, song)
}

// serveLocalTrackAbs 发送本地曲库文件(支持 Range,http.ServeContent 自动处理)。
func serveLocalTrackAbs(c *gin.Context, track *localMusicTrack) {
	file, err := os.Open(track.absPath)
	if err != nil {
		respondSubsonicError(c, errSubsonicNotFound)
		return
	}
	defer file.Close()
	c.Header("Content-Type", localAudioMimeByExt(track.Ext))
	http.ServeContent(c.Writer, c.Request, track.Filename, track.modTime, file)
}

// streamOnlineAndCache 在线反代播放,并后台完整下载落盘入库。
func streamOnlineAndCache(c *gin.Context, song model.Song) {
	dlFunc := core.GetDownloadFunc(song.Source)
	if dlFunc == nil {
		respondSubsonicError(c, errSubsonicNotFound)
		return
	}
	downloadURL, err := dlFunc(&song)
	if err != nil || downloadURL == "" {
		respondSubsonicError(c, errSubsonicNotFound)
		return
	}

	// 后台完整下载入库(去重),不阻塞当次在线播放。
	triggerBackgroundDownload(song)

	// 在线反代播放:优先 Range 拉取(支持拖进度),透传上游响应。
	rangeHeader := c.GetHeader("Range")
	if rangeFetch, handled, rangeErr := core.NewSourceRangeFetch(downloadURL, song.Source, rangeHeader); rangeErr == nil && handled {
		ext := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(rangeFetch.Ext, ".")))
		if ext == "" {
			ext = "mp3"
		}
		c.Header("Content-Type", core.AudioMimeByExt(ext))
		c.Header("Accept-Ranges", "bytes")
		c.Header("Content-Length", strconv.FormatInt(rangeFetch.ContentLength, 10))
		if rangeFetch.ContentRange != "" {
			c.Header("Content-Range", rangeFetch.ContentRange)
		}
		c.Status(rangeFetch.StatusCode)
		if writeErr := rangeFetch.WriteTo(c.Writer); writeErr != nil {
			log.Printf("[subsonic] stream range 写出失败 %s-%s: %v", song.Name, song.Artist, writeErr)
		}
		return
	}

	// 退化:直接 GET 透传。
	req, reqErr := core.BuildSourceRequest("GET", downloadURL, song.Source, rangeHeader)
	if reqErr != nil {
		respondSubsonicError(c, errSubsonicNotFound)
		return
	}
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		log.Printf("[subsonic] stream 上游请求失败 %s-%s: %v", song.Name, song.Artist, err)
		respondSubsonicError(c, errSubsonicNotFound)
		return
	}
	defer resp.Body.Close()
	ext := core.DetectAudioExtByContentType(resp.Header.Get("Content-Type"))
	if ext == "" {
		ext = "mp3"
	}
	c.Header("Content-Type", core.AudioMimeByExt(ext))
	c.Status(resp.StatusCode)
	if _, copyErr := io.Copy(c.Writer, resp.Body); copyErr != nil {
		log.Printf("[subsonic] stream 透传失败 %s-%s: %v", song.Name, song.Artist, copyErr)
	}
}

// findDownloadedTrack 在共享下载目录的扫描快照里查找与在线歌曲匹配的已下载文件。
// 匹配策略:标题 + 艺人 归一化后相等(大小写/空白不敏感)。
// 找到则返回本地 track(可直接发文件);没有返回 nil。
func findDownloadedTrack(song model.Song) *localMusicTrack {
	tracks, _, exists, _, _, _ := scanLocalMusicTracksCached(false)
	if !exists || len(tracks) == 0 {
		return nil
	}
	wantName := normalizeMatchKey(song.Name)
	wantArtist := normalizeMatchKey(song.Artist)
	if wantName == "" {
		return nil
	}
	for _, t := range tracks {
		if t == nil {
			continue
		}
		if normalizeMatchKey(t.Name) != wantName {
			continue
		}
		// 艺人能对上更可信;在线无艺人或本地无艺人时只凭标题匹配。
		if wantArtist != "" && normalizeMatchKey(t.Artist) != "" &&
			normalizeMatchKey(t.Artist) != wantArtist {
			continue
		}
		return t
	}
	return nil
}

// normalizeMatchKey 归一化匹配键:去空白、转小写。
func normalizeMatchKey(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

// triggerBackgroundDownload 启动后台完整下载+刮削落盘(去重)。
// 同一首歌(source+id)在下载中不重复启动。
func triggerBackgroundDownload(song model.Song) {
	key := extraKey(song.Source, song.ID)
	if _, loaded := downloadInFlight.LoadOrStore(key, true); loaded {
		return // 已在下载中
	}
	go func() {
		defer downloadInFlight.Delete(key)
		settings := core.GetWebSettings()
		// 再查一次:可能在排队期间已被其他途径下载。
		if findDownloadedTrack(song) != nil {
			return
		}
		s := song // 拷贝避免共享
		_, err := core.SaveSongToFileWithTemplate(&s, settings.DownloadDir, true, true, settings.DownloadFilenameTemplate)
		if err != nil {
			log.Printf("[subsonic] 后台下载入库失败 %s-%s: %v", song.Name, song.Artist, err)
			return
		}
		log.Printf("[subsonic] 已入库 %s-%s (source=%s)", song.Name, song.Artist, song.Source)
		// 主动刷新扫描快照,使曲库浏览/下次匹配能尽快看到。
		refreshLocalMusicScanAsync(localMusicDownloadDir())
	}()
}

package web

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/guohuiyuan/go-music-dl/core"
	"github.com/guohuiyuan/music-lib/model"
	"github.com/guohuiyuan/music-lib/soda"
)

const playbackSegmentContentType = `audio/mp4; codecs="flac"`

type playbackSegmentInput struct {
	reader     io.ReadCloser
	ext        string
	sourceKind string
}

type cappedLogBuffer struct {
	bytes.Buffer
	limit int
}

func (b *cappedLogBuffer) Write(p []byte) (int, error) {
	originalLen := len(p)
	remaining := b.limit - b.Len()
	if remaining > 0 {
		if len(p) > remaining {
			p = p[:remaining]
		}
		_, _ = b.Buffer.Write(p)
	}
	// ffmpeg 不应因诊断日志达到上限而收到短写错误。
	return originalLen, nil
}

func registerPlaybackSegmentRoute(api *gin.RouterGroup) {
	api.GET("/playback_segment", playbackSegmentHandler)
}

// playbackSegmentHandler 将每首在线音频转换为可追加到同一 MediaSource 的
// fragmented MP4。统一输出 FLAC codec：FLAC 输入只转封装，其他输入转为
// 无损 FLAC，避免为了连续播放把无损源降成有损格式。
func playbackSegmentHandler(c *gin.Context) {
	id := strings.TrimSpace(c.Query("id"))
	source := strings.TrimSpace(c.Query("source"))
	if id == "" || source == "" {
		c.String(http.StatusBadRequest, "Missing params")
		return
	}

	song := &model.Song{
		ID:     id,
		Source: source,
		Name:   strings.TrimSpace(c.Query("name")),
		Artist: strings.TrimSpace(c.Query("artist")),
		Album:  strings.TrimSpace(c.Query("album")),
		Cover:  strings.TrimSpace(c.Query("cover")),
		Extra:  parseSongExtraQuery(c.Query("extra")),
	}
	if song.Name == "" {
		song.Name = "Unknown"
	}
	if song.Artist == "" {
		song.Artist = "Unknown"
	}
	if song.Album == "" && song.Extra != nil {
		song.Album = strings.TrimSpace(song.Extra["album"])
	}
	if rawChunk := strings.TrimSpace(c.Query("chunk")); rawChunk != "" {
		playbackChunkHandler(c, song, rawChunk)
		return
	}

	input, err := openPlaybackSegmentInput(c, song)
	if err != nil {
		log.Printf("[playback-segment] 打开音频失败 source=%q id=%q: %v", source, id, err)
		c.String(http.StatusBadGateway, "Failed to open playback source")
		return
	}
	defer input.reader.Close()

	ffmpegPath, err := core.ResolveFFmpegPath()
	if err != nil {
		log.Printf("[playback-segment] 找不到 ffmpeg: %v", err)
		c.String(http.StatusServiceUnavailable, "ffmpeg unavailable")
		return
	}

	cmd := exec.CommandContext(c.Request.Context(), ffmpegPath, playbackSegmentFFmpegArgs(input.ext)...)
	cmd.Stdin = input.reader
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		log.Printf("[playback-segment] 创建 ffmpeg stdout 失败: %v", err)
		c.String(http.StatusInternalServerError, "Failed to prepare media segment")
		return
	}
	stderr := cappedLogBuffer{limit: 32 * 1024}
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		log.Printf("[playback-segment] 启动 ffmpeg 失败: %v", err)
		c.String(http.StatusServiceUnavailable, "Failed to start ffmpeg")
		return
	}

	// 在写 200 之前至少等到一个输出字节。输入损坏或 codec 不可处理时，
	// 能返回明确的 502，而不是先发空的成功响应再静默断流。
	output := bufio.NewReaderSize(stdout, 64*1024)
	if _, err := output.Peek(1); err != nil {
		waitErr := cmd.Wait()
		log.Printf("[playback-segment] ffmpeg 未产生输出 source=%q id=%q ext=%q err=%v stderr=%s",
			source, id, input.ext, waitErr, compactFFmpegError(stderr.String()))
		c.String(http.StatusBadGateway, "Failed to prepare media segment")
		return
	}

	c.Header("Content-Type", playbackSegmentContentType)
	c.Header("Cache-Control", "private, no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("X-Melodex-Playback-Source", input.sourceKind)
	c.Header("X-Melodex-Segment-Codec", "flac")
	c.Header("X-Melodex-Segment-Container", "fmp4")
	clearWriteDeadline(c)
	c.Status(http.StatusOK)

	_, copyErr := io.Copy(c.Writer, output)
	waitErr := cmd.Wait()
	if copyErr != nil {
		log.Printf("[playback-segment] 写响应中断 source=%q id=%q: %v", source, id, copyErr)
	}
	if waitErr != nil && c.Request.Context().Err() == nil {
		log.Printf("[playback-segment] ffmpeg 失败 source=%q id=%q ext=%q: %v stderr=%s",
			source, id, input.ext, waitErr, compactFFmpegError(stderr.String()))
	}
}

func playbackSegmentFFmpegArgs(inputExt string) []string {
	args := []string{
		"-hide_banner",
		"-loglevel", "error",
		"-i", "pipe:0",
		"-map", "0:a:0",
		"-vn",
		"-sn",
		"-dn",
		"-map_metadata", "-1",
	}
	if normalizePlaybackAudioExt(inputExt) == "flac" {
		args = append(args, "-c:a", "copy")
	} else {
		args = append(args, "-c:a", "flac", "-compression_level", "5")
	}
	return append(args,
		"-f", "mp4",
		"-movflags", "frag_keyframe+empty_moov+default_base_moof",
		"-frag_duration", "1000000",
		"pipe:1",
	)
}

func compactFFmpegError(message string) string {
	message = strings.Join(strings.Fields(message), " ")
	if len(message) > 800 {
		return message[:800]
	}
	return message
}

func openPlaybackSegmentInput(c *gin.Context, song *model.Song) (*playbackSegmentInput, error) {
	if isLocalMusicSource(song.Source) {
		return openLocalPlaybackSegmentInput(c, song.ID, "local")
	}

	// 与普通 Web 播放一致：当前用户有服务器副本时优先读 NAS，避免在线链接
	// 已过期，并且保证连续播放与界面“服务器”状态指向同一份真实文件。
	rel, err := existingDownloadRelPathForPlayback(
		currentUserID(c),
		currentUserIsAdmin(c),
		localMusicDownloadDir(),
		song.Source,
		song.ID,
		song.Name,
		song.Artist,
	)
	if err != nil {
		return nil, fmt.Errorf("resolve server copy: %w", err)
	}
	if rel != "" {
		return openLocalPlaybackSegmentInput(c, encodeLocalMusicID(rel), "server")
	}

	if song.Source == "soda" {
		return openSodaPlaybackSegmentInput(song)
	}

	downloadFunc := core.GetDownloadFunc(song.Source)
	if downloadFunc == nil {
		return nil, fmt.Errorf("unknown source %q", song.Source)
	}
	downloadURL, err := downloadFunc(song)
	if err != nil {
		markQualityCacheInvalid(*song)
		return nil, fmt.Errorf("get download url: %w", err)
	}

	if rangeFetch, handled, rangeErr := core.NewSourceRangeFetch(downloadURL, song.Source, ""); rangeErr != nil {
		markQualityCacheInvalid(*song)
		return nil, fmt.Errorf("prepare range source: %w", rangeErr)
	} else if handled {
		reader, writer := io.Pipe()
		go func() {
			writer.CloseWithError(rangeFetch.WriteTo(writer))
		}()
		return &playbackSegmentInput{
			reader:     reader,
			ext:        firstPlaybackAudioExt(rangeFetch.Ext, song.Ext),
			sourceKind: "network",
		}, nil
	}

	req, err := core.BuildSourceRequest(http.MethodGet, downloadURL, song.Source, "")
	if err != nil {
		return nil, fmt.Errorf("build upstream request: %w", err)
	}
	resp, err := outboundStreamingHTTPClient.Do(req)
	if err != nil {
		markQualityCacheInvalid(*song)
		return nil, fmt.Errorf("open upstream stream: %w", err)
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		resp.Body.Close()
		markQualityCacheInvalid(*song)
		return nil, fmt.Errorf("upstream status %d", resp.StatusCode)
	}

	ext := core.DetectAudioExtByContentType(resp.Header.Get("Content-Type"))
	if ext == "" {
		if parsed, parseErr := url.Parse(downloadURL); parseErr == nil {
			ext = normalizePlaybackAudioExt(path.Ext(parsed.Path))
		}
	}
	return &playbackSegmentInput{
		reader:     resp.Body,
		ext:        firstPlaybackAudioExt(ext, song.Ext),
		sourceKind: "network",
	}, nil
}

func openLocalPlaybackSegmentInput(c *gin.Context, id string, sourceKind string) (*playbackSegmentInput, error) {
	track, err := localMusicTrackByID(id)
	if err != nil {
		return nil, err
	}
	if !currentUserIsAdmin(c) {
		owned, err := downloadedRelPathsForUser(currentUserID(c))
		if err != nil {
			return nil, fmt.Errorf("ownership check: %w", err)
		}
		if _, ok := owned[normalizeRelPath(track.RelPath)]; !ok {
			return nil, os.ErrNotExist
		}
	}
	file, err := os.Open(track.absPath)
	if err != nil {
		return nil, err
	}
	return &playbackSegmentInput{
		reader:     file,
		ext:        normalizePlaybackAudioExt(track.Ext),
		sourceKind: sourceKind,
	}, nil
}

func openSodaPlaybackSegmentInput(song *model.Song) (*playbackSegmentInput, error) {
	cookie := core.CM.Get("soda")
	info, err := soda.New(cookie).GetDownloadInfo(song)
	if err != nil {
		markQualityCacheInvalid(*song)
		return nil, err
	}
	req, err := core.BuildSourceRequest(http.MethodGet, info.URL, "soda", "")
	if err != nil {
		return nil, err
	}
	resp, err := outboundStreamingHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		markQualityCacheInvalid(*song)
		return nil, fmt.Errorf("soda upstream status %d", resp.StatusCode)
	}
	encrypted, err := readLimitedBody(resp.Body, maxBufferedAudioBytes)
	if err != nil {
		return nil, err
	}
	decrypted, err := soda.DecryptAudio(encrypted, info.PlayAuth)
	if err != nil {
		return nil, err
	}
	return &playbackSegmentInput{
		reader:     io.NopCloser(bytes.NewReader(decrypted)),
		ext:        normalizePlaybackAudioExt(core.DetectAudioExt(decrypted)),
		sourceKind: "network",
	}, nil
}

func firstPlaybackAudioExt(candidates ...string) string {
	for _, candidate := range candidates {
		if ext := normalizePlaybackAudioExt(candidate); ext != "" {
			return ext
		}
	}
	return "mp3"
}

func normalizePlaybackAudioExt(ext string) string {
	ext = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(ext, ".")))
	switch ext {
	case "mp3", "flac", "ogg", "oga", "opus", "m4a", "mp4", "aac", "wav", "wave", "wma", "ape":
		return ext
	default:
		return ""
	}
}

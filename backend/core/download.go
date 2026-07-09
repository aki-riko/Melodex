package core

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/guohuiyuan/music-lib/model"
	"github.com/guohuiyuan/music-lib/soda"
	"github.com/guohuiyuan/music-lib/utils"
)

type DownloadedSong struct {
	Data        []byte
	Ext         string
	ContentType string
	Filename    string
	SavedPath   string
	Warning     string
	// Skipped 为 true 表示因已存在同名的同等或更高音质文件而未写入新文件,
	// SavedPath 指向已存在的那个文件。
	Skipped bool
	// RemovedPaths 是本次「音质升级」删除的同名低音质旧文件的绝对路径,
	// 上层据此清理下载归属记录(download_records),避免孤儿。
	RemovedPaths []string
}

// audioQualityRank 返回音频格式的音质优先级,数字越大音质越高(无损优先)。
// 用于跨格式去重:同一首歌只保留最高音质的一份。
func audioQualityRank(ext string) int {
	switch strings.ToLower(strings.TrimSpace(strings.TrimPrefix(ext, "."))) {
	case "flac", "wav":
		return 5 // 无损
	case "m4a", "aac":
		return 3 // 高码率有损
	case "ogg":
		return 2
	case "mp3":
		return 1
	case "wma":
		return 0
	default:
		return 1 // 未知按 mp3 档处理
	}
}

// isAudioExt 判断扩展名是否属于已知音频格式。
func isAudioExt(ext string) bool {
	switch strings.ToLower(strings.TrimSpace(strings.TrimPrefix(ext, "."))) {
	case "flac", "wav", "m4a", "aac", "ogg", "mp3", "wma":
		return true
	default:
		return false
	}
}

func DownloadSongData(song *model.Song, withCover bool, withLyrics bool) (*DownloadedSong, error) {
	return DownloadSongDataWithTemplate(song, withCover, withLyrics, DefaultDownloadFilenameTemplate)
}

func DownloadSongDataWithTemplate(song *model.Song, withCover bool, withLyrics bool, filenameTemplate string) (*DownloadedSong, error) {
	if song == nil {
		return nil, errors.New("song is nil")
	}
	if strings.TrimSpace(song.ID) == "" || strings.TrimSpace(song.Source) == "" {
		return nil, errors.New("missing song id or source")
	}

	normalized := *song
	normalized.Name = strings.TrimSpace(normalized.Name)
	normalized.Artist = strings.TrimSpace(normalized.Artist)
	normalized.Album = strings.TrimSpace(normalized.Album)
	if normalized.Name == "" {
		normalized.Name = "Unknown"
	}
	if normalized.Artist == "" {
		normalized.Artist = "Unknown"
	}

	audioData, contentType, err := fetchSongAudio(&normalized)
	if err != nil {
		return nil, err
	}
	if !LooksLikeAudioData(contentType, audioData) {
		return nil, fmt.Errorf("upstream response is not audio: %s", contentType)
	}

	signatureExt := DetectAudioExtBySignature(audioData)
	ext := signatureExt
	if ext == "" {
		ext = DetectAudioExtByContentType(contentType)
	}
	if ext == "" {
		ext = DetectAudioExt(audioData)
	}

	var lyric string
	if withLyrics {
		if lyricFn := GetLyricFunc(normalized.Source); lyricFn != nil {
			lyric, _ = lyricFn(&normalized)
		}
	}

	var coverData []byte
	var coverMime string
	if withCover && strings.TrimSpace(normalized.Cover) != "" {
		coverData, coverMime, _ = FetchResourceBytesWithMime(normalized.Cover, normalized.Source)
		// 国内源(尤其咪咕)封面常为 webp,而 ID3/FLAC 封面被多数播放器/刮削器
		// 仅识别 JPEG/PNG。这里把非 JPEG/PNG 的封面转成 JPEG,保证封面能被识别。
		if len(coverData) > 0 {
			if jpegData, ok := ensureJpegCover(coverData, coverMime); ok {
				coverData = jpegData
				coverMime = "image/jpeg"
			}
		}
	}

	finalData := audioData
	warning := ""
	if (ext == "mp3" || ext == "flac" || ext == "m4a" || ext == "wma") && (normalized.Album != "" || lyric != "" || len(coverData) > 0) {
		embeddedData, embedErr := EmbedSongMetadata(audioData, &normalized, lyric, coverData, coverMime)
		switch {
		case embedErr == nil:
			finalData = embeddedData
		case errors.Is(embedErr, ErrFFmpegNotFound):
			warning = "ffmpeg not found, metadata embedding skipped"
		default:
			warning = "metadata embedding failed, using original audio"
		}
	}

	if ext == "" {
		ext = DetectAudioExt(finalData)
	}

	return &DownloadedSong{
		Data:        finalData,
		Ext:         ext,
		ContentType: AudioMimeByExt(ext),
		Filename:    BuildDownloadFilename(&normalized, ext, filenameTemplate),
		Warning:     warning,
	}, nil
}

func SaveSongToFile(song *model.Song, outDir string, withCover bool, withLyrics bool) (*DownloadedSong, error) {
	return SaveSongToFileWithTemplate(song, outDir, withCover, withLyrics, DefaultDownloadFilenameTemplate)
}

func SaveSongToFileWithTemplate(song *model.Song, outDir string, withCover bool, withLyrics bool, filenameTemplate string) (*DownloadedSong, error) {
	result, err := DownloadSongDataWithTemplate(song, withCover, withLyrics, filenameTemplate)
	if err != nil {
		return nil, err
	}
	return saveDownloadedSongToFile(result, outDir)
}

func saveDownloadedSongToFile(result *DownloadedSong, outDir string) (*DownloadedSong, error) {
	if result == nil {
		return nil, errors.New("download result is nil")
	}

	targetDir := strings.TrimSpace(outDir)
	if targetDir == "" {
		targetDir = DefaultWebDownloadDir
	}
	targetDir = filepath.Clean(targetDir)

	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return nil, err
	}

	fileName := sanitizeDownloadRelativePath(result.Filename)
	filePath := filepath.Join(targetDir, fileName)
	if err := os.MkdirAll(filepath.Dir(filePath), 0755); err != nil {
		return nil, err
	}

	// 跨格式音质去重:扫描同目录下同名(仅扩展名不同)的已存在音频文件。
	// 已有同等或更高音质 → 跳过写入,返回已存在文件;
	// 已有更低音质 → 写入新文件后删除旧的低音质文件(音质升级)。
	newRank := audioQualityRank(result.Ext)
	existing, scanErr := findSameNameAudioFiles(filePath)
	if scanErr == nil {
		for _, ex := range existing {
			exRank := audioQualityRank(strings.TrimPrefix(filepath.Ext(ex), "."))
			if exRank >= newRank {
				// 已有同等或更高音质,不重复写入,直接复用已存在文件。
				result.Filename = filepath.Base(ex)
				result.SavedPath = ex
				result.Skipped = true
				return result, nil
			}
		}
	}

	if err := os.WriteFile(filePath, result.Data, 0644); err != nil {
		return nil, err
	}

	// 新文件音质更高,删除同名的低音质旧文件并上报路径供上层清理归属记录。
	for _, ex := range existing {
		if ex == filePath {
			continue
		}
		if err := os.Remove(ex); err == nil {
			result.RemovedPaths = append(result.RemovedPaths, ex)
		}
	}

	result.Filename = fileName
	result.SavedPath = filePath
	return result, nil
}

// findSameNameAudioFiles 返回与 filePath 同名(去扩展名后相同)但扩展名不同的
// 已存在音频文件绝对路径列表。仅在同一目录内查找,不递归。
func findSameNameAudioFiles(filePath string) ([]string, error) {
	dir := filepath.Dir(filePath)
	base := filepath.Base(filePath)
	stem := strings.TrimSuffix(base, filepath.Ext(base))

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var matches []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if name == base {
			continue // 同名同格式,由 WriteFile 覆盖处理,不算跨格式重复
		}
		nameExt := filepath.Ext(name)
		nameStem := strings.TrimSuffix(name, nameExt)
		if nameStem == stem && isAudioExt(nameExt) {
			matches = append(matches, filepath.Join(dir, name))
		}
	}
	return matches, nil
}

func BuildDownloadFilename(song *model.Song, ext string, filenameTemplate string) string {
	template := strings.TrimSpace(filenameTemplate)
	if template == "" {
		template = DefaultDownloadFilenameTemplate
	}
	ext = strings.TrimSpace(strings.TrimPrefix(ext, "."))

	name := "Unknown"
	artist := "Unknown"
	album := ""
	source := ""
	id := ""
	if song != nil {
		if strings.TrimSpace(song.Name) != "" {
			name = strings.TrimSpace(song.Name)
		}
		if strings.TrimSpace(song.Artist) != "" {
			artist = strings.TrimSpace(song.Artist)
		}
		album = strings.TrimSpace(song.Album)
		source = strings.TrimSpace(song.Source)
		id = strings.TrimSpace(song.ID)
	}
	name = sanitizeDownloadTemplateValue(name, "Unknown")
	artist = sanitizeDownloadTemplateValue(artist, "Unknown")
	album = sanitizeDownloadTemplateValue(album, "")
	source = sanitizeDownloadTemplateValue(source, "")
	id = sanitizeDownloadTemplateValue(id, "")

	hasExtToken := strings.Contains(template, "{ext}")
	rendered := strings.NewReplacer(
		"{name}", name,
		"{artist}", artist,
		"{album}", album,
		"{source}", source,
		"{id}", id,
		"{ext}", ext,
	).Replace(template)
	rendered = strings.TrimSpace(rendered)
	if rendered == "" {
		rendered = strings.TrimSpace(DefaultDownloadFilenameTemplate)
		rendered = strings.NewReplacer("{name}", name, "{artist}", artist, "{album}", album, "{source}", source, "{id}", id, "{ext}", ext).Replace(rendered)
	}
	if !hasExtToken && ext != "" {
		rendered += "." + ext
	}

	return sanitizeDownloadRelativePath(rendered)
}

func sanitizeDownloadRelativePath(name string) string {
	name = strings.ReplaceAll(strings.TrimSpace(name), "\\", "/")
	parts := strings.Split(name, "/")
	safeParts := make([]string, 0, len(parts))
	for _, part := range parts {
		part = sanitizeDownloadPathSegment(part)
		if part == "" || part == "." || part == ".." {
			continue
		}
		safeParts = append(safeParts, part)
	}
	if len(safeParts) == 0 {
		return "download"
	}
	return filepath.Join(safeParts...)
}

func sanitizeDownloadTemplateValue(value string, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	value = sanitizeDownloadPathSegment(value)
	if value == "" {
		return fallback
	}
	return value
}

func sanitizeDownloadPathSegment(value string) string {
	value = strings.Trim(value, " .")
	if value == "" {
		return ""
	}
	return strings.Trim(utils.SanitizeFilename(value), " .")
}

func fetchSongAudio(song *model.Song) ([]byte, string, error) {
	if song.Source == "soda" {
		cookie := CM.Get("soda")
		sodaInst := soda.New(cookie)
		info, err := sodaInst.GetDownloadInfo(song)
		if err != nil {
			return nil, "", err
		}

		encryptedData, _, err := FetchBytesWithMime(info.URL, "soda")
		if err != nil {
			return nil, "", err
		}

		finalData, err := soda.DecryptAudio(encryptedData, info.PlayAuth)
		if err != nil {
			return nil, "", err
		}
		return finalData, "", nil
	}

	dlFunc := GetDownloadFunc(song.Source)
	if dlFunc == nil {
		return nil, "", fmt.Errorf("unsupported source: %s", song.Source)
	}

	urlStr, err := dlFunc(song)
	if err != nil {
		return nil, "", err
	}
	if urlStr == "" {
		return nil, "", errors.New("empty download url")
	}

	return FetchBytesWithMime(urlStr, song.Source)
}

// ensureJpegCover 把非 JPEG/PNG 的封面(如国内源常见的 webp)转成 JPEG。
// 已是 JPEG/PNG 的返回 (nil,false) 表示无需替换;转换成功返回 (jpegData,true);
// 转换失败(无 ffmpeg 等)也返回 (nil,false),保持原封面不阻断下载。
func ensureJpegCover(data []byte, mime string) ([]byte, bool) {
	m := strings.ToLower(strings.TrimSpace(mime))
	// 按实际字节嗅探,mime 不可信时兜底
	if m == "" {
		m = http.DetectContentType(data)
	}
	if strings.Contains(m, "jpeg") || strings.Contains(m, "jpg") || strings.Contains(m, "png") {
		return nil, false // 主流播放器都认,无需转
	}

	ffmpegPath, err := ResolveFFmpegPath()
	if err != nil {
		return nil, false
	}
	// 从 stdin 读任意格式图,转码为 JPEG 输出到 stdout
	cmd := exec.Command(ffmpegPath, "-hide_banner", "-loglevel", "error",
		"-i", "pipe:0", "-f", "image2", "-c:v", "mjpeg", "-q:v", "3", "pipe:1")
	cmd.Stdin = bytes.NewReader(data)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil || out.Len() == 0 {
		return nil, false
	}
	return out.Bytes(), true
}

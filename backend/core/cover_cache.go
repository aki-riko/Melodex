package core

import (
	"crypto/sha1"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 封面磁盘缓存:封面图是不可变资源(URL 变则内容变),缓存命中率极高。
// 落盘到 data/cache/covers/<sha1(url)>.<ext>,随 data 卷持久化(NAS)。
const (
	coverCacheDir     = "data/cache/covers"
	coverCacheMaxSize = 512 * 1024 * 1024 // 软上限 512MB,超过触发按 mtime 清理
)

var (
	coverCacheMu      sync.Mutex
	coverCacheLastGC  time.Time
	coverCacheDirOnce sync.Once
)

// coverCacheRoot 返回封面缓存目录(相对 cwd,与 data/downloads 同卷)。可被测试覆盖。
var coverCacheRoot = func() string { return coverCacheDir }

func coverCachePath(url, contentType string) string {
	sum := sha1.Sum([]byte(url))
	name := hex.EncodeToString(sum[:])
	ext := coverExtFromContentType(contentType)
	return filepath.Join(coverCacheRoot(), name+ext)
}

// coverCacheGlob 用于查找某 url 对应的已缓存文件(不知道 ext 时按前缀匹配)。
func coverCacheLookup(url string) (string, bool) {
	sum := sha1.Sum([]byte(url))
	name := hex.EncodeToString(sum[:])
	matches, err := filepath.Glob(filepath.Join(coverCacheRoot(), name+".*"))
	if err != nil || len(matches) == 0 {
		return "", false
	}
	return matches[0], true
}

func coverExtFromContentType(ct string) string {
	ct = strings.ToLower(strings.TrimSpace(ct))
	switch {
	case strings.Contains(ct, "png"):
		return ".png"
	case strings.Contains(ct, "webp"):
		return ".webp"
	case strings.Contains(ct, "gif"):
		return ".gif"
	default:
		return ".jpg"
	}
}

func contentTypeFromExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	default:
		return "image/jpeg"
	}
}

// GetCachedCover 返回封面字节与 content-type。先查磁盘缓存,未命中则回源并落盘。
// 任何缓存读写错误都不阻断主流程(回退为直接回源)。
func GetCachedCover(url, source string) ([]byte, string, error) {
	if path, ok := coverCacheLookup(url); ok {
		if data, err := os.ReadFile(path); err == nil && len(data) > 0 {
			return data, contentTypeFromExt(filepath.Ext(path)), nil
		}
	}

	data, contentType, err := FetchBytesWithMime(url, source)
	if err != nil || len(data) == 0 {
		return data, contentType, err
	}
	if contentType == "" {
		contentType = "image/jpeg"
	}

	// 仅缓存"看起来确实是图片"的响应,避免把上游的防盗链/限流 HTML 错误页
	// 当封面落盘(否则会被 7 天 TTL 固化,所有人拿到坏图)。校验:
	//   ① content-type 为 image/*,或 ② 字节magic 是常见图片格式
	// 且大小在合理区间(封面通常几十 KB,>8MB 视为异常不缓存)。
	if isLikelyImage(contentType, data) && len(data) <= coverMaxBytes {
		saveCoverToCache(url, contentType, data)
	}
	return data, contentType, nil
}

const coverMaxBytes = 8 * 1024 * 1024

// isLikelyImage 判断响应是否为图片:content-type 为 image/*,或字节头匹配
// JPEG/PNG/GIF/WebP/BMP magic number(防上游不给/给错 content-type)。
func isLikelyImage(contentType string, data []byte) bool {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "image/") {
		return true
	}
	if len(data) < 12 {
		return false
	}
	switch {
	case data[0] == 0xFF && data[1] == 0xD8: // JPEG
		return true
	case data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G': // PNG
		return true
	case data[0] == 'G' && data[1] == 'I' && data[2] == 'F': // GIF
		return true
	case data[0] == 'B' && data[1] == 'M': // BMP
		return true
	case string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP": // WebP
		return true
	}
	return false
}

func saveCoverToCache(url, contentType string, data []byte) {
	coverCacheDirOnce.Do(func() {
		_ = os.MkdirAll(coverCacheRoot(), 0755)
	})
	path := coverCachePath(url, contentType)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return
	}
	maybeGCCoverCache()
}

// maybeGCCoverCache 节流地检查缓存目录总大小,超过软上限时按 mtime 删最旧的,
// 直到降到上限的 80%。最多每 10 分钟跑一次,避免每次写都全目录扫描。
func maybeGCCoverCache() {
	coverCacheMu.Lock()
	defer coverCacheMu.Unlock()
	if time.Since(coverCacheLastGC) < 10*time.Minute {
		return
	}
	coverCacheLastGC = time.Now()

	entries, err := os.ReadDir(coverCacheRoot())
	if err != nil {
		return
	}
	type fileInfo struct {
		path    string
		size    int64
		modTime time.Time
	}
	files := make([]fileInfo, 0, len(entries))
	var total int64
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, fileInfo{
			path:    filepath.Join(coverCacheRoot(), e.Name()),
			size:    info.Size(),
			modTime: info.ModTime(),
		})
		total += info.Size()
	}
	if total <= coverCacheMaxSize {
		return
	}

	// 按 mtime 升序(最旧在前),删到降至上限 80%。
	for i := 0; i < len(files); i++ {
		for j := i + 1; j < len(files); j++ {
			if files[j].modTime.Before(files[i].modTime) {
				files[i], files[j] = files[j], files[i]
			}
		}
	}
	var target int64 = coverCacheMaxSize * 8 / 10
	for _, f := range files {
		if total <= target {
			break
		}
		if err := os.Remove(f.path); err == nil {
			total -= f.size
		}
	}
}

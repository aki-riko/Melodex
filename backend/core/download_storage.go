package core

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

// audioQualityRanks 只作为「已知音频扩展名」的白名单使用(isAudioExt)。
//
// 它的数值曾是下载覆盖判定的音质序,但那张表把编码格式序当成了音质序
// (aac/m4a=3 > ogg=2 > mp3=1),会错误地把 320k mp3 判给 128k ogg 替换。
// 现在覆盖判定改由 downloadCandidateIsNotBetter 按「无损 > 有损、同档比体积」判断,
// 数值本身不再参与音质比较,保留是为了继续识别扩展名。
var audioQualityRanks = map[string]int{
	"wma": 0, "mp3": 1, "ogg": 2, "aac": 3, "m4a": 3, "flac": 5, "wav": 5,
}

// losslessAudioExtensions 是真正的音质判据:无损 vs 有损。
var losslessAudioExtensions = map[string]struct{}{
	"flac": {}, "wav": {}, "alac": {}, "ape": {}, "wv": {}, "tta": {}, "dsf": {}, "dff": {},
}

// audioBitrateUpgradeRatio 是同为有损时按体积判定升级的阈值。
//
// 「128k mp3 → 320k mp3」用扩展名比不出来(两者都是 mp3),只能按体积估码率。
// 阈值取 1.25 而不是 1.0,是为了吸收元数据差异:嵌封面/歌词会让同一码率的文件
// 大百分之十几,若用 1.0 会把它误判成升级从而反复重写同一个文件。
const audioBitrateUpgradeRatio = 1.25

const downloadedAudioFileMode = 0o644

func normalizedAudioExtension(extension string) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(extension), "."))
}

func isLosslessAudioExtension(extension string) bool {
	_, ok := losslessAudioExtensions[normalizedAudioExtension(extension)]
	return ok
}

func isAudioExt(extension string) bool {
	_, known := audioQualityRanks[normalizedAudioExtension(extension)]
	return known
}

func SaveSongToFile(track *model.Track, outputDirectory string, withCover, withLyrics bool) (*DownloadedSong, error) {
	return SaveSongToFileWithTemplate(track, outputDirectory, withCover, withLyrics, DefaultDownloadFilenameTemplate)
}

func SaveSongToFileWithTemplate(track *model.Track, outputDirectory string, withCover, withLyrics bool, filenameTemplate string) (*DownloadedSong, error) {
	download, err := DownloadSongDataWithTemplate(track, withCover, withLyrics, filenameTemplate)
	if err != nil {
		return nil, err
	}
	return saveDownloadedSongToFile(download, outputDirectory)
}

func SaveDownloadedSongDataToFile(download *DownloadedSong, outputDirectory string) (*DownloadedSong, error) {
	return saveDownloadedSongToFile(download, outputDirectory)
}

func saveDownloadedSongToFile(download *DownloadedSong, outputDirectory string) (*DownloadedSong, error) {
	if download == nil {
		return nil, errors.New("download result is nil")
	}
	if outputDirectory = strings.TrimSpace(outputDirectory); outputDirectory == "" {
		outputDirectory = DefaultWebDownloadDir
	}
	outputDirectory = filepath.Clean(outputDirectory)
	if err := os.MkdirAll(outputDirectory, 0o755); err != nil {
		return nil, err
	}
	relativeName := sanitizeDownloadRelativePath(download.Filename)
	target := filepath.Join(outputDirectory, relativeName)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return nil, err
	}
	versions, err := findSameNameAudioFiles(target)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	extension := firstNonEmptyDownloadExtension(download.Ext, filepath.Ext(relativeName))
	for _, version := range versions {
		if downloadCandidateIsNotBetter(version, extension, int64(len(download.Data))) {
			download.Filename = filepath.Base(version)
			download.SavedPath = version
			download.Skipped = true
			return download, nil
		}
	}
	if err := writeAudioFile(target, download.Data); err != nil {
		return nil, err
	}
	for _, version := range versions {
		if sameFilePath(version, target) {
			continue
		}
		if err := os.Remove(version); err != nil {
			download.Warning = appendDownloadWarning(download.Warning, fmt.Sprintf("remove old version %s: %v", filepath.Base(version), err))
			continue
		}
		download.RemovedPaths = append(download.RemovedPaths, version)
	}
	download.Filename, download.SavedPath = relativeName, target
	return download, nil
}

// downloadCandidateIsNotBetter 判断磁盘上已有的同名(同 stem)文件是否已经不比本次下载差。
//
// 历史:早期实现只用扩展名 rank 比较,而 rank 表(mp3=1,ogg=2,aac/m4a=3)表达的其实是
// "编码格式序"而不是"音质序"。于是 320k 的 mp3 会被 128k 的 ogg 判为"升级"(rank 2 > 1)
// 而被替换 —— 用更小的文件换掉更好的音频,是真实存在的降质缺陷。
//
// 现在的口径:
//   - 一方无损、另一方有损 → 无损胜(与扩展名/体积无关);
//   - 双方都无损 → 保留磁盘已有版本(flac/wav 之间体积差不代表音质差);
//   - 双方都有损 → 按体积比(≈同曲目下的码率比),跨编码格式也成立。
//
// 阈值 audioBitrateUpgradeRatio 用来吸收元数据体积差异(嵌封面/歌词),避免把
// 同一码率的重复下载误判成升级而反复重写文件。
//
// 注意:调用方只会把**文件名不同**的同名版本传进来(target 自身被
// findSameNameAudioFiles 排除),所以"完全同名同格式重下"仍会无条件覆盖 ——
// 这是刻意的,它让损坏/截断的旧文件能被一次正常下载修好。
func downloadCandidateIsNotBetter(existingPath, newExtension string, newSize int64) bool {
	existingExtension := normalizedAudioExtension(filepath.Ext(existingPath))
	existingLossless := isLosslessAudioExtension(existingExtension)
	newLossless := isLosslessAudioExtension(newExtension)
	if existingLossless != newLossless {
		return existingLossless
	}
	if existingLossless {
		return true
	}
	if newSize <= 0 {
		return true
	}
	existingInfo, err := os.Stat(existingPath)
	if err != nil || existingInfo.Size() <= 0 {
		return true
	}
	return float64(newSize) < float64(existingInfo.Size())*audioBitrateUpgradeRatio
}

func firstNonEmptyDownloadExtension(values ...string) string {
	for _, value := range values {
		if value = normalizedAudioExtension(value); value != "" {
			return value
		}
	}
	return "mp3"
}

func writeAudioFile(target string, data []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(target), ".melodex-download-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	// os.CreateTemp 固定创建 0600。最终文件经 Rename 继承该权限；若运行身份
	// 曾是 root，之后降权运行的 appuser 就无法播放已下载的服务器副本。
	if err := temporary.Chmod(downloadedAudioFileMode); err != nil {
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, target); err != nil {
		if _, statErr := os.Stat(target); statErr != nil {
			return err
		}
		if err := os.Remove(target); err != nil {
			return err
		}
		if err := os.Rename(temporaryPath, target); err != nil {
			return err
		}
	}
	committed = true
	return nil
}

func findSameNameAudioFiles(targetPath string) ([]string, error) {
	directory := filepath.Dir(targetPath)
	targetName := filepath.Base(targetPath)
	targetStem := strings.TrimSuffix(targetName, filepath.Ext(targetName))
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	versions := make([]string, 0)
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() == targetName || !isAudioExt(filepath.Ext(entry.Name())) {
			continue
		}
		if strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())) == targetStem {
			versions = append(versions, filepath.Join(directory, entry.Name()))
		}
	}
	sort.Strings(versions)
	return versions, nil
}

func sameFilePath(left, right string) bool {
	return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
}

func appendDownloadWarning(existing, next string) string {
	if strings.TrimSpace(existing) == "" {
		return next
	}
	return existing + "; " + next
}

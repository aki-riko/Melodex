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

var audioQualityRanks = map[string]int{
	"wma": 0, "mp3": 1, "ogg": 2, "aac": 3, "m4a": 3, "flac": 5, "wav": 5,
}

func normalizedAudioExtension(extension string) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(extension), "."))
}

func audioQualityRank(extension string) int {
	rank, known := audioQualityRanks[normalizedAudioExtension(extension)]
	if !known {
		return audioQualityRanks["mp3"]
	}
	return rank
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
	newRank := audioQualityRank(extension)
	for _, version := range versions {
		if audioQualityRank(filepath.Ext(version)) >= newRank {
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

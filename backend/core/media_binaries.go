package core

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	ffmpegEnvName  = "MUSIC_DL_FFMPEG"
	ffprobeEnvName = "MUSIC_DL_FFPROBE"
)

func ResolveFFmpegPath() (string, error) {
	return resolveMediaExecutable(ffmpegEnvName, "ffmpeg")
}

func ResolveFFprobePath() (string, error) {
	return resolveMediaExecutable(ffprobeEnvName, "ffprobe")
}

func resolveMediaExecutable(environmentName, defaultExecutable string) (string, error) {
	configured := strings.TrimSpace(os.Getenv(environmentName))
	if configured == "" {
		path, err := exec.LookPath(defaultExecutable)
		if err != nil {
			return "", fmt.Errorf("find %s in PATH: %w", defaultExecutable, err)
		}
		return path, nil
	}
	if !filepath.IsAbs(configured) {
		path, err := exec.LookPath(configured)
		if err != nil {
			return "", fmt.Errorf("find executable configured by %s: %w", environmentName, err)
		}
		return path, nil
	}
	info, err := os.Stat(configured)
	if err != nil {
		return "", fmt.Errorf("read executable configured by %s: %w", environmentName, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s does not reference a regular file", environmentName)
	}
	return filepath.Clean(configured), nil
}

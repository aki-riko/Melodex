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

type mediaToolSpec struct {
	environment string
	executable  string
}

func ResolveFFmpegPath() (string, error) {
	return locateMediaTool(mediaToolSpec{environment: ffmpegEnvName, executable: "ffmpeg"})
}

func ResolveFFprobePath() (string, error) {
	return locateMediaTool(mediaToolSpec{environment: ffprobeEnvName, executable: "ffprobe"})
}

func locateMediaTool(spec mediaToolSpec) (string, error) {
	configured := strings.TrimSpace(os.Getenv(spec.environment))
	if configured == "" {
		return exec.LookPath(spec.executable)
	}
	if !filepath.IsAbs(configured) {
		resolved, err := exec.LookPath(configured)
		if err != nil {
			return "", fmt.Errorf("resolve %s=%q: %w", spec.environment, configured, err)
		}
		return resolved, nil
	}

	info, err := os.Stat(configured)
	if err != nil {
		return "", fmt.Errorf("inspect %s=%q: %w", spec.environment, configured, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s must point to a regular file: %q", spec.environment, configured)
	}
	return configured, nil
}

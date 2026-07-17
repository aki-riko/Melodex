package web

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"

	"github.com/guohuiyuan/go-music-dl/core"
)

func TestPlaybackSegmentFFmpegArgsPreserveFLAC(t *testing.T) {
	args := playbackSegmentFFmpegArgs(".FLAC")
	if !containsAdjacentArgs(args, "-c:a", "copy") {
		t.Fatalf("FLAC args should copy codec, got %v", args)
	}
	if !containsAdjacentArgs(args, "-f", "mp4") {
		t.Fatalf("segment container should be mp4, got %v", args)
	}
	if !containsAdjacentArgs(args, "-frag_duration", "1000000") {
		t.Fatalf("segment output should use one-second fragments, got %v", args)
	}
}

func TestPlaybackSegmentFFmpegArgsTranscodeLosslessly(t *testing.T) {
	for _, ext := range []string{"mp3", "m4a", "ogg", "wav", ""} {
		args := playbackSegmentFFmpegArgs(ext)
		if !containsAdjacentArgs(args, "-c:a", "flac") {
			t.Fatalf("%q input should transcode to lossless FLAC, got %v", ext, args)
		}
		if slices.Contains(args, "libmp3lame") || slices.Contains(args, "aac") {
			t.Fatalf("%q input must not use a lossy output codec, got %v", ext, args)
		}
	}
}

func TestPlaybackSegmentProducesFLACInFragmentedMP4(t *testing.T) {
	ffmpegPath, err := core.ResolveFFmpegPath()
	if err != nil {
		t.Skipf("ffmpeg unavailable: %v", err)
	}
	ffprobePath, err := core.ResolveFFprobePath()
	if err != nil {
		t.Skipf("ffprobe unavailable: %v", err)
	}

	dir := t.TempDir()
	inputPath := filepath.Join(dir, "input.flac")
	generate := exec.Command(ffmpegPath,
		"-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
		"-t", "0.4", "-c:a", "flac", inputPath,
	)
	if output, err := generate.CombinedOutput(); err != nil {
		t.Fatalf("generate FLAC fixture: %v: %s", err, output)
	}

	input, err := os.Open(inputPath)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	outputPath := filepath.Join(dir, "segment.mp4")
	output, err := os.Create(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(ffmpegPath, playbackSegmentFFmpegArgs("flac")...)
	cmd.Stdin = input
	cmd.Stdout = output
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		output.Close()
		t.Fatalf("create playback segment: %v: %s", err, stderr.String())
	}
	if err := output.Close(); err != nil {
		t.Fatal(err)
	}

	probe := exec.Command(ffprobePath,
		"-v", "error",
		"-show_entries", "stream=codec_name,codec_tag_string,sample_rate,channels",
		"-show_entries", "format=format_name,duration",
		"-of", "json",
		outputPath,
	)
	probeOutput, err := probe.Output()
	if err != nil {
		t.Fatalf("probe playback segment: %v", err)
	}
	var payload struct {
		Streams []struct {
			CodecName      string `json:"codec_name"`
			CodecTagString string `json:"codec_tag_string"`
			SampleRate     string `json:"sample_rate"`
			Channels       int    `json:"channels"`
		} `json:"streams"`
		Format struct {
			FormatName string `json:"format_name"`
			Duration   string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(probeOutput, &payload); err != nil {
		t.Fatalf("decode ffprobe output: %v: %s", err, probeOutput)
	}
	if len(payload.Streams) != 1 {
		t.Fatalf("stream count = %d, want 1: %s", len(payload.Streams), probeOutput)
	}
	stream := payload.Streams[0]
	if stream.CodecName != "flac" || stream.CodecTagString != "fLaC" {
		t.Fatalf("codec = %s/%s, want flac/fLaC", stream.CodecName, stream.CodecTagString)
	}
	if stream.SampleRate != "48000" || stream.Channels != 1 {
		t.Fatalf("audio format = %sHz/%dch, want 48000Hz/1ch", stream.SampleRate, stream.Channels)
	}
	if payload.Format.Duration == "" || payload.Format.FormatName == "" {
		t.Fatalf("missing MP4 format metadata: %s", probeOutput)
	}
}

func containsAdjacentArgs(args []string, first string, second string) bool {
	for index := 0; index+1 < len(args); index++ {
		if args[index] == first && args[index+1] == second {
			return true
		}
	}
	return false
}

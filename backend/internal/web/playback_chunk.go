package web

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/guohuiyuan/go-music-dl/core"
	"github.com/guohuiyuan/music-lib/model"
)

const (
	playbackChunkDurationSeconds = 12
	playbackChunkMaxIndex        = 2047
	playbackChunkMaxJobs         = 16
	playbackChunkJobLifetime     = 30 * time.Minute
	playbackChunkIdleTTL         = 10 * time.Minute
)

type playbackChunkJob struct {
	key        string
	dir        string
	source     string
	songID     string
	sourceKind string
	manifest   string
	done       chan struct{}
	ctx        context.Context
	cancel     context.CancelFunc

	mu         sync.RWMutex
	err        error
	lastAccess time.Time
}

var playbackChunkJobStore = struct {
	sync.Mutex
	jobs map[string]*playbackChunkJob
}{jobs: make(map[string]*playbackChunkJob)}

func playbackChunkHandler(c *gin.Context, song *model.Song, rawChunk string) {
	chunkIndex, err := strconv.Atoi(rawChunk)
	if err != nil || chunkIndex < 0 || chunkIndex > playbackChunkMaxIndex {
		c.String(http.StatusBadRequest, "Invalid chunk")
		return
	}

	job, err := getOrCreatePlaybackChunkJob(c, song, chunkIndex)
	if err != nil {
		log.Printf("[playback-chunk] 创建任务失败 source=%q id=%q chunk=%d: %v", song.Source, song.ID, chunkIndex, err)
		c.String(http.StatusBadGateway, "Failed to prepare playback chunk")
		return
	}
	job.touch()
	chunkPath, final, err := job.waitForChunk(c.Request.Context(), chunkIndex)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return
		}
		if errors.Is(err, io.EOF) {
			c.String(http.StatusRequestedRangeNotSatisfiable, "Chunk out of range")
			return
		}
		log.Printf("[playback-chunk] 生成失败 source=%q id=%q chunk=%d: %v", song.Source, song.ID, chunkIndex, err)
		c.String(http.StatusBadGateway, "Failed to generate playback chunk")
		return
	}
	if err := servePlaybackChunk(c, job, chunkPath, chunkIndex, final); err != nil {
		log.Printf("[playback-chunk] 写响应失败 source=%q id=%q chunk=%d: %v", song.Source, song.ID, chunkIndex, err)
	}
}

func getOrCreatePlaybackChunkJob(c *gin.Context, song *model.Song, chunkIndex int) (*playbackChunkJob, error) {
	key, err := playbackChunkJobKey(currentUserID(c), currentUserIsAdmin(c), song)
	if err != nil {
		return nil, err
	}
	if existing := reusablePlaybackChunkJob(key, chunkIndex); existing != nil {
		return existing, nil
	}

	ffmpegPath, err := core.ResolveFFmpegPath()
	if err != nil {
		return nil, fmt.Errorf("resolve ffmpeg: %w", err)
	}
	input, err := openPlaybackSegmentInput(c, song)
	if err != nil {
		return nil, fmt.Errorf("open source: %w", err)
	}
	job, err := newPlaybackChunkJob(key, song, input.sourceKind)
	if err != nil {
		input.reader.Close()
		return nil, err
	}

	existing, installErr := installPlaybackChunkJob(job, chunkIndex)
	if installErr != nil {
		job.cleanup()
		input.reader.Close()
		return nil, installErr
	}
	if existing != nil {
		job.cleanup()
		input.reader.Close()
		return existing, nil
	}
	go job.run(ffmpegPath, input)
	return job, nil
}

func reusablePlaybackChunkJob(key string, chunkIndex int) *playbackChunkJob {
	playbackChunkJobStore.Lock()
	defer playbackChunkJobStore.Unlock()
	job := playbackChunkJobStore.jobs[key]
	if job == nil {
		return nil
	}
	_, ready, _, terminalErr := job.inspectChunk(chunkIndex)
	if terminalErr != nil && !ready {
		delete(playbackChunkJobStore.jobs, key)
		go job.cleanup()
		return nil
	}
	job.touch()
	return job
}

func installPlaybackChunkJob(candidate *playbackChunkJob, chunkIndex int) (*playbackChunkJob, error) {
	playbackChunkJobStore.Lock()
	defer playbackChunkJobStore.Unlock()
	if existing := playbackChunkJobStore.jobs[candidate.key]; existing != nil {
		_, ready, _, terminalErr := existing.inspectChunk(chunkIndex)
		if terminalErr == nil || ready {
			existing.touch()
			return existing, nil
		}
		delete(playbackChunkJobStore.jobs, candidate.key)
		go existing.cleanup()
	}
	prunePlaybackChunkJobsLocked()
	if len(playbackChunkJobStore.jobs) >= playbackChunkMaxJobs {
		return nil, errors.New("too many playback chunk jobs")
	}
	playbackChunkJobStore.jobs[candidate.key] = candidate
	return nil, nil
}

func prunePlaybackChunkJobsLocked() {
	now := time.Now()
	for key, job := range playbackChunkJobStore.jobs {
		if now.Sub(job.lastUsed()) < playbackChunkIdleTTL {
			continue
		}
		delete(playbackChunkJobStore.jobs, key)
		go job.cleanup()
	}
}

func newPlaybackChunkJob(key string, song *model.Song, sourceKind string) (*playbackChunkJob, error) {
	dir, err := os.MkdirTemp("", "melodex-playback-chunks-*")
	if err != nil {
		return nil, fmt.Errorf("create chunk dir: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), playbackChunkJobLifetime)
	job := &playbackChunkJob{
		key:        key,
		dir:        dir,
		source:     song.Source,
		songID:     song.ID,
		sourceKind: sourceKind,
		manifest:   filepath.Join(dir, "segments.csv"),
		done:       make(chan struct{}),
		cancel:     cancel,
		ctx:        ctx,
		lastAccess: time.Now(),
	}
	return job, nil
}

func (job *playbackChunkJob) run(ffmpegPath string, input *playbackSegmentInput) {
	defer input.reader.Close()
	defer job.cancel()
	pattern := filepath.Join(job.dir, "%06d.mp4")
	cmd := exec.CommandContext(job.ctx, ffmpegPath, playbackChunkFFmpegArgs(input.ext, pattern, job.manifest)...)
	cmd.Stdin = input.reader
	stderr := cappedLogBuffer{limit: 32 * 1024}
	cmd.Stderr = &stderr
	err := cmd.Run()
	if job.ctx.Err() != nil {
		err = job.ctx.Err()
	}
	if err != nil {
		err = fmt.Errorf("ffmpeg: %w: %s", err, compactFFmpegError(stderr.String()))
		log.Printf("[playback-chunk] ffmpeg 失败 source=%q id=%q: %v", job.source, job.songID, err)
	}
	job.finish(err)
}

func playbackChunkFFmpegArgs(inputExt string, outputPattern string, manifestPath string) []string {
	args := []string{
		"-hide_banner", "-loglevel", "error",
		"-i", "pipe:0",
		"-map", "0:a:0",
		"-vn", "-sn", "-dn",
		"-map_metadata", "-1",
	}
	if normalizePlaybackAudioExt(inputExt) == "flac" {
		args = append(args, "-c:a", "copy")
	} else {
		args = append(args, "-c:a", "flac", "-compression_level", "5")
	}
	return append(args,
		"-f", "segment",
		"-segment_time", strconv.Itoa(playbackChunkDurationSeconds),
		"-reset_timestamps", "1",
		"-segment_list", manifestPath,
		"-segment_list_type", "csv",
		"-segment_list_flags", "+live",
		"-segment_format", "mp4",
		"-segment_format_options", "movflags=frag_keyframe+empty_moov+default_base_moof",
		outputPattern,
	)
}

func (job *playbackChunkJob) waitForChunk(ctx context.Context, chunkIndex int) (string, bool, error) {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		chunkPath, ready, final, terminalErr := job.inspectChunk(chunkIndex)
		if ready || terminalErr != nil {
			return chunkPath, final, terminalErr
		}
		select {
		case <-ctx.Done():
			return "", false, ctx.Err()
		case <-job.done:
		case <-ticker.C:
		}
	}
}

func (job *playbackChunkJob) inspectChunk(chunkIndex int) (string, bool, bool, error) {
	chunkPath := job.chunkPath(chunkIndex)
	currentInfo, currentErr := os.Stat(chunkPath)
	if currentErr != nil && !errors.Is(currentErr, os.ErrNotExist) {
		return "", false, false, currentErr
	}
	completedCount, err := completedPlaybackChunkCount(job.manifest)
	if err != nil {
		return "", false, false, err
	}
	finished, jobErr := job.result()
	currentExists := currentErr == nil && currentInfo.Size() > 0
	if currentExists && completedCount > chunkIndex+1 {
		return chunkPath, true, false, nil
	}
	if currentExists && finished && chunkIndex < completedCount {
		final := jobErr == nil && chunkIndex == completedCount-1
		return chunkPath, true, final, nil
	}
	if !finished {
		return chunkPath, false, false, nil
	}
	if jobErr != nil {
		return chunkPath, false, false, jobErr
	}
	if currentExists {
		return chunkPath, true, true, nil
	}
	return chunkPath, false, false, io.EOF
}

func completedPlaybackChunkCount(manifestPath string) (int, error) {
	data, err := os.ReadFile(manifestPath)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	completed := 0
	for _, rawLine := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(rawLine)
		fields := strings.Split(line, ",")
		if len(fields) != 3 || strings.TrimSpace(fields[0]) != fmt.Sprintf("%06d.mp4", completed) {
			continue
		}
		completed++
	}
	return completed, nil
}

func servePlaybackChunk(c *gin.Context, job *playbackChunkJob, chunkPath string, chunkIndex int, final bool) error {
	file, err := os.Open(chunkPath)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	c.Header("Content-Type", playbackSegmentContentType)
	c.Header("Content-Length", strconv.FormatInt(info.Size(), 10))
	c.Header("Cache-Control", "private, no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("X-Melodex-Playback-Source", job.sourceKind)
	c.Header("X-Melodex-Segment-Codec", "flac")
	c.Header("X-Melodex-Segment-Container", "fmp4")
	c.Header("X-Melodex-Chunk-Index", strconv.Itoa(chunkIndex))
	c.Header("X-Melodex-Chunk-Duration", strconv.Itoa(playbackChunkDurationSeconds))
	if final {
		c.Header("X-Melodex-Chunk-Final", "1")
	} else {
		c.Header("X-Melodex-Chunk-Final", "0")
	}
	clearWriteDeadline(c)
	c.Status(http.StatusOK)
	_, err = io.Copy(c.Writer, file)
	job.touch()
	return err
}

func playbackChunkJobKey(userID uint, admin bool, song *model.Song) (string, error) {
	payload, err := json.Marshal(struct {
		UserID uint        `json:"user_id"`
		Admin  bool        `json:"admin"`
		Song   *model.Song `json:"song"`
	}{UserID: userID, Admin: admin, Song: song})
	if err != nil {
		return "", fmt.Errorf("encode playback chunk key: %w", err)
	}
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:]), nil
}

func (job *playbackChunkJob) chunkPath(index int) string {
	return filepath.Join(job.dir, fmt.Sprintf("%06d.mp4", index))
}

func (job *playbackChunkJob) finish(err error) {
	job.mu.Lock()
	job.err = err
	job.mu.Unlock()
	close(job.done)
	time.AfterFunc(playbackChunkIdleTTL, func() {
		removePlaybackChunkJobIfIdle(job)
	})
}

func (job *playbackChunkJob) result() (bool, error) {
	select {
	case <-job.done:
		job.mu.RLock()
		defer job.mu.RUnlock()
		return true, job.err
	default:
		return false, nil
	}
}

func (job *playbackChunkJob) touch() {
	job.mu.Lock()
	job.lastAccess = time.Now()
	job.mu.Unlock()
}

func (job *playbackChunkJob) lastUsed() time.Time {
	job.mu.RLock()
	defer job.mu.RUnlock()
	return job.lastAccess
}

func (job *playbackChunkJob) cleanup() {
	job.cancel()
	if err := os.RemoveAll(job.dir); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("[playback-chunk] 清理临时目录失败 dir=%q: %v", job.dir, err)
	}
}

func removePlaybackChunkJobIfIdle(job *playbackChunkJob) {
	if time.Since(job.lastUsed()) < playbackChunkIdleTTL {
		time.AfterFunc(playbackChunkIdleTTL, func() {
			removePlaybackChunkJobIfIdle(job)
		})
		return
	}
	playbackChunkJobStore.Lock()
	if playbackChunkJobStore.jobs[job.key] == job {
		delete(playbackChunkJobStore.jobs, job.key)
	}
	playbackChunkJobStore.Unlock()
	job.cleanup()
}

package maintenance

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/dhowden/tag"
	"github.com/guohuiyuan/go-music-dl/core"
	"github.com/guohuiyuan/music-lib/model"
	"gorm.io/gorm"
)

var (
	errAudioMissing      = errors.New("audio file is missing")
	errUnsupportedSource = errors.New("lyrics source is unsupported")
	timedLyricLineRE     = regexp.MustCompile(`(?m)^\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\s*\S`)
)

type downloadRecord struct {
	ID      uint
	UserID  uint
	RelPath string
	Source  string
	SongID  string
	Name    string
	Artist  string
}

func (downloadRecord) TableName() string { return "download_records" }

// LyricsBackfillOptions controls a download-record-driven sidecar lyrics pass.
// DryRun defaults to the caller-provided value; commands should default it to true.
type LyricsBackfillOptions struct {
	DownloadDir       string
	DryRun            bool
	Limit             int
	Delay             time.Duration
	Output            io.Writer
	FetchLyric        func(source string, song *model.Song) (string, error)
	ReadEmbeddedLyric func(audioPath string) (string, error)
}

type LyricsBackfillSummary struct {
	Inspected        int
	Matched          int
	Written          int
	ExistingEmbedded int
	ExistingSidecar  int
	MissingFiles     int
	InvalidPaths     int
	Conflicts        int
	Unsupported      int
	FetchFailures    int
	WriteFailures    int
	UnusableLyrics   int
}

type lyricCandidate struct {
	record   downloadRecord
	invalid  error
	conflict bool
}

type candidateResult struct {
	status  string
	detail  string
	fetched bool
}

func BackfillLyrics(ctx context.Context, db *gorm.DB, options LyricsBackfillOptions) (LyricsBackfillSummary, error) {
	options = normalizeLyricsBackfillOptions(options)
	rootAbs, rootReal, err := resolveDownloadRoot(options.DownloadDir)
	if err != nil {
		return LyricsBackfillSummary{}, err
	}
	records, err := loadDownloadRecords(db)
	if err != nil {
		return LyricsBackfillSummary{}, err
	}
	candidates := uniqueLyricCandidates(records, options.Limit)
	return runLyricsCandidates(ctx, rootAbs, rootReal, candidates, options)
}

func normalizeLyricsBackfillOptions(options LyricsBackfillOptions) LyricsBackfillOptions {
	if options.Output == nil {
		options.Output = io.Discard
	}
	if options.FetchLyric == nil {
		options.FetchLyric = fetchLyricFromSource
	}
	if options.ReadEmbeddedLyric == nil {
		options.ReadEmbeddedLyric = readEmbeddedLyric
	}
	if options.Delay < 0 {
		options.Delay = 0
	}
	return options
}

func resolveDownloadRoot(downloadDir string) (string, string, error) {
	downloadDir = strings.TrimSpace(downloadDir)
	if downloadDir == "" {
		return "", "", errors.New("download directory is required")
	}
	rootAbs, err := filepath.Abs(downloadDir)
	if err != nil {
		return "", "", fmt.Errorf("resolve download directory: %w", err)
	}
	info, err := os.Stat(rootAbs)
	if err != nil || !info.IsDir() {
		return "", "", fmt.Errorf("download directory is unavailable: %s", rootAbs)
	}
	rootReal, err := filepath.EvalSymlinks(rootAbs)
	if err != nil {
		return "", "", fmt.Errorf("resolve real download directory: %w", err)
	}
	return rootAbs, rootReal, nil
}

func loadDownloadRecords(db *gorm.DB) ([]downloadRecord, error) {
	if db == nil {
		return nil, errors.New("database is required")
	}
	var records []downloadRecord
	err := db.Order("rel_path ASC, id DESC").Find(&records).Error
	if err != nil {
		return nil, fmt.Errorf("load download records: %w", err)
	}
	return records, nil
}

func uniqueLyricCandidates(records []downloadRecord, limit int) []lyricCandidate {
	candidates := make([]lyricCandidate, 0, len(records))
	positions := make(map[string]int, len(records))
	for _, raw := range records {
		record, invalid := normalizeDownloadRecord(raw)
		key := record.RelPath
		if invalid != nil {
			key = "\x00invalid\x00" + fmt.Sprint(record.ID)
		}
		if position, ok := positions[key]; ok {
			mergeLyricCandidate(&candidates[position], record)
			continue
		}
		positions[key] = len(candidates)
		candidates = append(candidates, lyricCandidate{record: record, invalid: invalid})
	}
	if limit > 0 && len(candidates) > limit {
		return candidates[:limit]
	}
	return candidates
}

func normalizeDownloadRecord(record downloadRecord) (downloadRecord, error) {
	record.RelPath = filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(record.RelPath))))
	record.Source = strings.ToLower(strings.TrimSpace(record.Source))
	record.SongID = strings.TrimSpace(record.SongID)
	record.Name = strings.TrimSpace(record.Name)
	record.Artist = strings.TrimSpace(record.Artist)
	if record.RelPath == "." || filepath.IsAbs(filepath.FromSlash(record.RelPath)) || pathEscapesRoot(record.RelPath) {
		return record, errors.New("unsafe relative path")
	}
	return record, nil
}

func pathEscapesRoot(relPath string) bool {
	relPath = filepath.Clean(filepath.FromSlash(relPath))
	return relPath == ".." || strings.HasPrefix(relPath, ".."+string(filepath.Separator))
}

func mergeLyricCandidate(candidate *lyricCandidate, record downloadRecord) {
	currentComplete := hasSongIdentity(candidate.record)
	incomingComplete := hasSongIdentity(record)
	if currentComplete && incomingComplete && !sameSongIdentity(candidate.record, record) {
		candidate.conflict = true
		return
	}
	if !currentComplete && incomingComplete {
		candidate.record = record
		return
	}
	if sameSongIdentity(candidate.record, record) {
		mergeRecordMetadata(&candidate.record, record)
	}
}

func hasSongIdentity(record downloadRecord) bool {
	return record.Source != "" && record.SongID != ""
}

func sameSongIdentity(left, right downloadRecord) bool {
	return left.Source == right.Source && left.SongID == right.SongID
}

func mergeRecordMetadata(target *downloadRecord, source downloadRecord) {
	if target.Name == "" {
		target.Name = source.Name
	}
	if target.Artist == "" {
		target.Artist = source.Artist
	}
}

func runLyricsCandidates(ctx context.Context, rootAbs, rootReal string, candidates []lyricCandidate, options LyricsBackfillOptions) (LyricsBackfillSummary, error) {
	var summary LyricsBackfillSummary
	for index, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return summary, err
		}
		result := processLyricCandidate(rootAbs, rootReal, candidate, options)
		summary.Inspected++
		applyCandidateResult(&summary, result)
		writeCandidateResult(options.Output, candidate.record, result)
		if result.fetched && index < len(candidates)-1 {
			if err := waitBackfillDelay(ctx, options.Delay); err != nil {
				return summary, err
			}
		}
	}
	return summary, nil
}

func processLyricCandidate(rootAbs, rootReal string, candidate lyricCandidate, options LyricsBackfillOptions) candidateResult {
	if candidate.invalid != nil {
		return candidateResult{status: "invalid_path", detail: candidate.invalid.Error()}
	}
	if candidate.conflict {
		return candidateResult{status: "conflict", detail: "multiple song identities share one file"}
	}
	if !hasSongIdentity(candidate.record) {
		return candidateResult{status: "unsupported", detail: "missing source or song_id"}
	}
	audioPath, err := resolveAudioPath(rootAbs, rootReal, candidate.record.RelPath)
	if err != nil {
		return audioPathFailure(err)
	}
	return backfillResolvedAudio(audioPath, candidate.record, options)
}

func audioPathFailure(err error) candidateResult {
	if errors.Is(err, errAudioMissing) {
		return candidateResult{status: "missing_file", detail: err.Error()}
	}
	return candidateResult{status: "invalid_path", detail: err.Error()}
}

func resolveAudioPath(rootAbs, rootReal, relPath string) (string, error) {
	targetAbs, err := filepath.Abs(filepath.Join(rootAbs, filepath.FromSlash(relPath)))
	if err != nil || !pathIsInside(rootAbs, targetAbs) {
		return "", errors.New("path escapes download directory")
	}
	info, err := os.Lstat(targetAbs)
	if os.IsNotExist(err) {
		return "", errAudioMissing
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("audio target is not a regular file")
	}
	targetReal, err := filepath.EvalSymlinks(targetAbs)
	if err != nil || !pathIsInside(rootReal, targetReal) {
		return "", errors.New("real audio path escapes download directory")
	}
	return targetAbs, nil
}

func pathIsInside(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func backfillResolvedAudio(audioPath string, record downloadRecord, options LyricsBackfillOptions) candidateResult {
	if sidecar := existingLyricSidecar(audioPath); sidecar != "" {
		return candidateResult{status: "existing_sidecar", detail: filepath.Base(sidecar)}
	}
	embedded, readErr := options.ReadEmbeddedLyric(audioPath)
	if strings.TrimSpace(embedded) != "" {
		return candidateResult{status: "existing_embedded", detail: "embedded lyrics present"}
	}
	if readErr != nil {
		fmt.Fprintf(options.Output, "WARN metadata rel=%q error=%q\n", record.RelPath, readErr.Error())
	}
	return fetchAndStoreLyric(audioPath, record, options)
}

func existingLyricSidecar(audioPath string) string {
	stem := strings.TrimSuffix(audioPath, filepath.Ext(audioPath))
	for _, extension := range []string{".lrc", ".txt", ".lyric"} {
		candidate := stem + extension
		if _, err := os.Lstat(candidate); err == nil {
			return candidate
		}
	}
	return ""
}

func fetchAndStoreLyric(audioPath string, record downloadRecord, options LyricsBackfillOptions) candidateResult {
	song := &model.Song{ID: record.SongID, Source: record.Source, Name: record.Name, Artist: record.Artist}
	lyrics, err := options.FetchLyric(record.Source, song)
	if errors.Is(err, errUnsupportedSource) {
		return candidateResult{status: "unsupported", detail: err.Error(), fetched: true}
	}
	if err != nil {
		return candidateResult{status: "fetch_failure", detail: err.Error(), fetched: true}
	}
	lyrics, timedLines, ok := normalizeUsableLyrics(lyrics)
	if !ok {
		return candidateResult{status: "unusable_lyrics", detail: "empty or non-timed lyrics", fetched: true}
	}
	if options.DryRun {
		return candidateResult{status: "dry_matched", detail: fmt.Sprintf("timed_lines=%d", timedLines), fetched: true}
	}
	return writeFetchedSidecar(audioPath, lyrics, timedLines)
}

func fetchLyricFromSource(source string, song *model.Song) (string, error) {
	fetch := core.GetLyricFunc(source)
	if fetch == nil {
		return "", fmt.Errorf("%w: %s", errUnsupportedSource, source)
	}
	return fetch(song)
}

func readEmbeddedLyric(audioPath string) (string, error) {
	file, err := os.Open(audioPath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	metadata, err := tag.ReadFrom(file)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(metadata.Lyrics()), nil
}

func normalizeUsableLyrics(raw string) (string, int, bool) {
	lyrics := strings.ReplaceAll(raw, "\r\n", "\n")
	lyrics = strings.ReplaceAll(lyrics, "\r", "\n")
	lyrics = strings.TrimSpace(lyrics)
	if lyrics == "" || strings.Contains(lyrics, "暂无歌词") || strings.Contains(lyrics, "纯音乐 / 无歌词") {
		return "", 0, false
	}
	timedLines := len(timedLyricLineRE.FindAllStringIndex(lyrics, -1))
	if timedLines == 0 {
		return "", 0, false
	}
	return lyrics + "\n", timedLines, true
}

func writeFetchedSidecar(audioPath, lyrics string, timedLines int) candidateResult {
	sidecarPath := strings.TrimSuffix(audioPath, filepath.Ext(audioPath)) + ".lrc"
	file, err := os.OpenFile(sidecarPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if os.IsExist(err) {
		return candidateResult{status: "existing_sidecar", detail: filepath.Base(sidecarPath), fetched: true}
	}
	if err != nil {
		return candidateResult{status: "write_failure", detail: err.Error(), fetched: true}
	}
	if err := writeAndSyncSidecar(file, sidecarPath, lyrics); err != nil {
		return candidateResult{status: "write_failure", detail: err.Error(), fetched: true}
	}
	return candidateResult{status: "written", detail: fmt.Sprintf("timed_lines=%d", timedLines), fetched: true}
}

func writeAndSyncSidecar(file *os.File, sidecarPath, lyrics string) error {
	_, writeErr := io.WriteString(file, lyrics)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr == nil && syncErr == nil && closeErr == nil {
		return nil
	}
	_ = os.Remove(sidecarPath)
	return errors.Join(writeErr, syncErr, closeErr)
}

func waitBackfillDelay(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func applyCandidateResult(summary *LyricsBackfillSummary, result candidateResult) {
	switch result.status {
	case "dry_matched":
		summary.Matched++
	case "written":
		summary.Matched++
		summary.Written++
	case "existing_embedded":
		summary.ExistingEmbedded++
	case "existing_sidecar":
		summary.ExistingSidecar++
	case "missing_file":
		summary.MissingFiles++
	case "invalid_path":
		summary.InvalidPaths++
	case "conflict":
		summary.Conflicts++
	case "unsupported":
		summary.Unsupported++
	case "fetch_failure":
		summary.FetchFailures++
	case "write_failure":
		summary.WriteFailures++
	case "unusable_lyrics":
		summary.UnusableLyrics++
	}
}

func writeCandidateResult(output io.Writer, record downloadRecord, result candidateResult) {
	fmt.Fprintf(output, "%s source=%q song_id=%q rel=%q %s\n",
		strings.ToUpper(result.status), record.Source, record.SongID, record.RelPath, result.detail)
}

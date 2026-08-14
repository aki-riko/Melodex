package web

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/dhowden/tag"
)

const (
	localMusicSource               = "local"
	legacyLocalMusicSource         = "local-file"
	localMusicScanCacheTTL         = 10 * time.Second
	localMusicMaxUploadBytes int64 = 200 * 1024 * 1024
)

var (
	localMusicMaxUploadRequestBytes int64 = localMusicMaxUploadBytes + 1024*1024
	localMusicDownloadDirProvider         = func() string { return core.GetWebSettings().DownloadDir }
	localMusicAudioExts                   = map[string]struct{}{
		".aac": {}, ".flac": {}, ".m4a": {}, ".mp3": {},
		".ogg": {}, ".wav": {}, ".wma": {},
	}
	localMusicCoverExts = []string{".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
	localMusicLyricExts = []string{".lrc", ".txt", ".lyric"}
)

type localMusicTrack struct {
	absPath string
	modTime time.Time

	ID           string            `json:"id"`
	Duration     int               `json:"duration"`
	Extra        map[string]string `json:"extra"`
	Source       string            `json:"source"`
	Size         int64             `json:"size"`
	Name         string            `json:"name"`
	ModifiedAt   time.Time         `json:"modified_at"`
	Artist       string            `json:"artist"`
	Album        string            `json:"album"`
	Cover        string            `json:"cover"`
	Filename     string            `json:"filename"`
	RelPath      string            `json:"rel_path"`
	Ext          string            `json:"ext"`
	SizeText     string            `json:"size_text"`
	Missing      []string          `json:"missing"`
	AlreadyAdded bool              `json:"already_added,omitempty"`
}

type localMusicScanSnapshot struct {
	ScannedAt time.Time
	Tracks    []*localMusicTrack
	Dir       string
	Err       error
	Exists    bool
}

type localMusicSnapshotStore struct {
	mu       sync.RWMutex
	snapshot localMusicScanSnapshot
}

type localMusicRefreshGate struct {
	mu     sync.Mutex
	active bool
}

var (
	localMusicMetaCacheMu sync.RWMutex
	localMusicMetaCache   = make(map[string]*localMusicTrack)

	localMusicSnapshots localMusicSnapshotStore
	localMusicRefresh   localMusicRefreshGate
)

func isLocalMusicSource(source string) bool {
	switch strings.TrimSpace(source) {
	case localMusicSource, legacyLocalMusicSource:
		return true
	default:
		return false
	}
}

func localMusicTracksToSongs(tracks []*localMusicTrack) []model.Track {
	result := make([]model.Track, 0, len(tracks))
	for _, track := range tracks {
		if track == nil {
			continue
		}
		result = append(result, model.Track{
			ID: track.ID, Source: localMusicSource, Name: track.Name,
			Artist: track.Artist, Album: track.Album, Cover: track.Cover,
			Duration: track.Duration, Extra: cloneStringMap(track.Extra),
		})
	}
	return result
}

func localMusicDownloadDir() string {
	dir := strings.TrimSpace(localMusicDownloadDirProvider())
	if dir != "" {
		return filepath.Clean(dir)
	}
	return filepath.Clean(core.DefaultWebDownloadDir)
}

func scanLocalMusicTracks() ([]*localMusicTrack, string, bool, error) {
	dir := localMusicDownloadDir()
	root, exists, rootErr := localLibraryRoot(dir)
	if rootErr != nil || !exists {
		return []*localMusicTrack{}, dir, exists, rootErr
	}

	tracks := make([]*localMusicTrack, 0, 64)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if entry.IsDir() {
			if path != root && strings.HasPrefix(entry.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !isLocalMusicAudioFile(path) {
			return nil
		}
		appendScannedLocalTrack(&tracks, root, path)
		return nil
	})
	if err != nil {
		return nil, dir, true, err
	}

	sort.SliceStable(tracks, func(i, j int) bool { return localTrackComesBefore(tracks[i], tracks[j]) })
	return tracks, dir, true, nil
}

func appendScannedLocalTrack(tracks *[]*localMusicTrack, root, path string) {
	track, err := buildLocalMusicTrackFast(root, path)
	if err == nil {
		*tracks = append(*tracks, track)
	}
}

func localTrackComesBefore(left, right *localMusicTrack) bool {
	if !left.modTime.Equal(right.modTime) {
		return left.modTime.After(right.modTime)
	}
	return strings.ToLower(left.RelPath) < strings.ToLower(right.RelPath)
}

func localLibraryRoot(dir string) (string, bool, error) {
	info, err := os.Stat(dir)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if !info.IsDir() {
		return "", false, fmt.Errorf("本地下载路径不是目录: %s", dir)
	}
	root, err := filepath.Abs(dir)
	return root, true, err
}

func scanLocalMusicTracksCached(force bool) ([]*localMusicTrack, string, bool, error, bool, time.Time) {
	dir := localMusicDownloadDir()
	if force {
		return scanAndStoreLocalMusic()
	}
	snapshot, found := cachedLocalMusicScanSnapshot(dir, false)
	if !found {
		return scanAndStoreLocalMusic()
	}
	if time.Since(snapshot.ScannedAt) < localMusicScanCacheTTL {
		return snapshot.Tracks, snapshot.Dir, snapshot.Exists, snapshot.Err, false, snapshot.ScannedAt
	}
	if snapshot.Err != nil {
		return scanAndStoreLocalMusic()
	}
	refreshLocalMusicScanAsync(dir)
	return snapshot.Tracks, snapshot.Dir, snapshot.Exists, nil, true, snapshot.ScannedAt
}

func scanAndStoreLocalMusic() ([]*localMusicTrack, string, bool, error, bool, time.Time) {
	tracks, dir, exists, err := scanLocalMusicTracks()
	snapshot := localMusicScanSnapshot{
		Dir: dir, Tracks: tracks, Exists: exists, Err: err, ScannedAt: time.Now(),
	}
	storeLocalMusicScanSnapshot(snapshot)
	return cloneLocalMusicTrackSlice(tracks), dir, exists, err, false, snapshot.ScannedAt
}

func refreshLocalMusicScanAsync(expectedDir string) {
	if !localMusicRefresh.begin() {
		return
	}
	go func() {
		defer localMusicRefresh.finish()
		tracks, dir, exists, err := scanLocalMusicTracks()
		if !sameCleanPath(dir, expectedDir) {
			return
		}
		storeLocalMusicScanSnapshot(localMusicScanSnapshot{Dir: dir, Tracks: tracks, Exists: exists, Err: err, ScannedAt: time.Now()})
	}()
}

func (gate *localMusicRefreshGate) begin() bool {
	gate.mu.Lock()
	defer gate.mu.Unlock()
	if gate.active {
		return false
	}
	gate.active = true
	return true
}

func (gate *localMusicRefreshGate) finish() {
	gate.mu.Lock()
	gate.active = false
	gate.mu.Unlock()
}

func cachedLocalMusicScanSnapshot(dir string, freshOnly bool) (localMusicScanSnapshot, bool) {
	snapshot := localMusicSnapshots.load()
	matchingDirectory := snapshot.Dir != "" && sameCleanPath(snapshot.Dir, dir)
	if !matchingDirectory {
		return localMusicScanSnapshot{}, false
	}
	expired := time.Since(snapshot.ScannedAt) >= localMusicScanCacheTTL
	if freshOnly && expired {
		return localMusicScanSnapshot{}, false
	}
	return snapshotWithClonedTracks(snapshot), true
}

func snapshotWithClonedTracks(snapshot localMusicScanSnapshot) localMusicScanSnapshot {
	snapshot.Tracks = cloneLocalMusicTrackSlice(snapshot.Tracks)
	return snapshot
}

func storeLocalMusicScanSnapshot(snapshot localMusicScanSnapshot) {
	snapshot.Tracks = cloneLocalMusicTrackSlice(snapshot.Tracks)
	localMusicSnapshots.store(snapshot)
}

func invalidateLocalMusicScanCache() {
	localMusicSnapshots.store(localMusicScanSnapshot{})
}

func (store *localMusicSnapshotStore) load() localMusicScanSnapshot {
	store.mu.RLock()
	snapshot := store.snapshot
	store.mu.RUnlock()
	return snapshot
}

func (store *localMusicSnapshotStore) store(snapshot localMusicScanSnapshot) {
	store.mu.Lock()
	store.snapshot = snapshot
	store.mu.Unlock()
}

func sameCleanPath(left, right string) bool {
	return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
}

func parseLocalMusicRangeInt(raw string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value < 0 {
		return fallback
	}
	return min(value, 1000)
}

func paginateLocalMusicTracks(tracks []*localMusicTrack, offset, limit int) []*localMusicTrack {
	offset = max(offset, 0)
	if offset >= len(tracks) {
		return []*localMusicTrack{}
	}
	end := len(tracks)
	if limit > 0 {
		end = min(end, offset+limit)
	}
	return tracks[offset:end]
}

func markAlreadyAddedLocalTracks(collectionID string, userID uint, tracks []*localMusicTrack) {
	if db == nil || strings.TrimSpace(collectionID) == "" || len(tracks) == 0 {
		return
	}
	collection, err := loadOwnedCollection(collectionID, userID)
	if err != nil || collection == nil || collection.isImported() {
		return
	}
	ids := make([]string, 0, len(tracks))
	for _, track := range tracks {
		ids = append(ids, track.ID)
	}
	var savedTracks []SavedSong
	if err := db.Where(
		"collection_id = ? AND source IN ? AND song_id IN ?",
		collection.ID, []string{localMusicSource, legacyLocalMusicSource}, ids,
	).Find(&savedTracks).Error; err != nil {
		return
	}
	added := make(map[string]struct{}, len(savedTracks))
	for _, song := range savedTracks {
		added[song.SongID] = struct{}{}
	}
	for _, track := range tracks {
		_, track.AlreadyAdded = added[track.ID]
	}
}

func isLocalMusicAudioFile(path string) bool {
	_, ok := localMusicAudioExts[strings.ToLower(filepath.Ext(path))]
	return ok
}

func buildLocalMusicTrackFast(rootAbs, audioPath string) (*localMusicTrack, error) {
	track, err := buildLocalMusicTrackFallback(rootAbs, audioPath)
	if err != nil {
		return nil, err
	}
	if cached := getCachedLocalMusicTrack(rootAbs, track.RelPath, track.Size, track.modTime); cached != nil {
		cached.absPath, cached.modTime = track.absPath, track.modTime
		return cached, nil
	}
	return enrichLocalMusicTrack(rootAbs, track)
}

func buildLocalMusicTrackFallback(rootAbs, audioPath string) (*localMusicTrack, error) {
	absPath, info, rel, err := resolveLocalAudio(rootAbs, audioPath)
	if err != nil {
		return nil, err
	}
	filename := info.Name()
	extWithDot := strings.ToLower(filepath.Ext(filename))
	ext := strings.TrimPrefix(extWithDot, ".")
	id := encodeLocalMusicID(rel)
	track := &localMusicTrack{
		ID: id, Source: localMusicSource,
		Name:   strings.TrimSpace(strings.TrimSuffix(filename, filepath.Ext(filename))),
		Artist: "未知歌手", Filename: filename, RelPath: rel, Ext: ext,
		Size: info.Size(), SizeText: core.FormatSize(info.Size()),
		ModifiedAt: info.ModTime(), Missing: []string{"title", "artist", "album"},
		Extra: map[string]string{
			"local_music": "true", "file_id": id, "filename": filename,
			"rel_path": rel, "ext": ext, "size": strconv.FormatInt(info.Size(), 10),
		},
		absPath: absPath, modTime: info.ModTime(),
	}
	applyExactSidecarHints(track)
	return track, nil
}

func buildLocalMusicTrack(rootAbs, audioPath string) (*localMusicTrack, error) {
	track, err := buildLocalMusicTrackFallback(rootAbs, audioPath)
	if err != nil {
		return nil, err
	}
	if cached := getCachedLocalMusicTrack(rootAbs, track.RelPath, track.Size, track.modTime); cached != nil {
		cached.absPath, cached.modTime = track.absPath, track.modTime
		return cached, nil
	}
	return enrichLocalMusicTrack(rootAbs, track)
}

func resolveLocalAudio(rootAbs, audioPath string) (string, os.FileInfo, string, error) {
	root, err := filepath.Abs(rootAbs)
	if err != nil {
		return "", nil, "", err
	}
	target, err := filepath.Abs(audioPath)
	if err != nil {
		return "", nil, "", err
	}
	if !isPathInside(root, target) {
		return "", nil, "", errors.New("path is outside local music dir")
	}

	// Lexical checks alone allow a symlink under the download directory to point outside it.
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", nil, "", err
	}
	realTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		return "", nil, "", err
	}
	if !isPathInside(realRoot, realTarget) {
		return "", nil, "", errors.New("local music symlink escaped root")
	}
	info, err := os.Stat(realTarget)
	if err != nil {
		return "", nil, "", err
	}
	if info.IsDir() || !isLocalMusicAudioFile(realTarget) {
		return "", nil, "", errors.New("not a supported audio file")
	}
	rel, err := filepath.Rel(realRoot, realTarget)
	if err != nil {
		return "", nil, "", err
	}
	return realTarget, info, filepath.ToSlash(rel), nil
}

func enrichLocalMusicTrack(rootAbs string, track *localMusicTrack) (*localMusicTrack, error) {
	if track == nil {
		return nil, errors.New("empty local music track")
	}
	if file, err := os.Open(track.absPath); err == nil {
		metadata, readErr := tag.ReadFrom(file)
		_ = file.Close()
		if readErr == nil {
			applyEmbeddedMetadata(track, metadata)
		}
	}
	applySidecarHints(track)
	if probe, err := probeLocalMusicTrack(track); err == nil {
		applyLocalProbeResult(track, probe)
	}
	cacheLocalMusicTrack(rootAbs, track)
	return track, nil
}

func applyEmbeddedMetadata(track *localMusicTrack, metadata tag.Metadata) {
	setMissingMetadata(track, "title", strings.TrimSpace(metadata.Title()))
	setMissingMetadata(track, "artist", strings.TrimSpace(metadata.Artist()))
	setMissingMetadata(track, "album", strings.TrimSpace(metadata.Album()))
	if picture := metadata.Picture(); picture != nil && len(picture.Data) > 0 {
		setLocalAssetHint(track, "cover", "embedded")
	}
	if strings.TrimSpace(metadata.Lyrics()) != "" {
		setLocalAssetHint(track, "lyric", "embedded")
	}
}

func setMissingMetadata(track *localMusicTrack, field, value string) {
	if value == "" || !containsString(track.Missing, field) {
		return
	}
	switch field {
	case "title":
		track.Name = value
	case "artist":
		track.Artist = value
	case "album":
		track.Album = value
	}
	track.Extra[field] = value
	track.Missing = removeString(track.Missing, field)
}

func applyExactSidecarHints(track *localMusicTrack) {
	if _, _, ok := localMusicExactSidecarFile(track.absPath, localMusicCoverExts); ok {
		setLocalAssetHint(track, "cover", "sidecar")
	}
	if _, _, ok := localMusicExactSidecarFile(track.absPath, localMusicLyricExts); ok {
		setLocalAssetHint(track, "lyric", "sidecar")
	}
}

func applySidecarHints(track *localMusicTrack) {
	if track.Extra["cover_source"] == "" {
		if _, _, ok := localMusicSidecarFile(track.absPath, localMusicCoverExts); ok {
			setLocalAssetHint(track, "cover", "sidecar")
		}
	}
	if track.Extra["lyric_source"] == "" {
		if _, _, ok := localMusicSidecarFile(track.absPath, localMusicLyricExts); ok {
			setLocalAssetHint(track, "lyric", "sidecar")
		}
	}
}

func setLocalAssetHint(track *localMusicTrack, kind, source string) {
	track.Extra[kind] = "true"
	track.Extra[kind+"_source"] = source
	if kind == "cover" {
		track.Cover = RoutePrefix + "/local_music/cover?id=" + url.QueryEscape(track.ID)
	}
}

func getCachedLocalMusicTrack(rootAbs, relPath string, size int64, modTime time.Time) *localMusicTrack {
	key := localMusicMetaCacheKey(rootAbs, relPath)
	localMusicMetaCacheMu.RLock()
	cached, found := localMusicMetaCache[key]
	localMusicMetaCacheMu.RUnlock()
	if !found || cached.Size != size || !cached.modTime.Equal(modTime) {
		return nil
	}
	return cloneLocalMusicTrack(cached)
}

func cacheLocalMusicTrack(rootAbs string, track *localMusicTrack) {
	if track == nil || strings.TrimSpace(track.RelPath) == "" {
		return
	}
	key := localMusicMetaCacheKey(rootAbs, track.RelPath)
	cached := cloneLocalMusicTrack(track)
	localMusicMetaCacheMu.Lock()
	localMusicMetaCache[key] = cached
	localMusicMetaCacheMu.Unlock()
}

func localMusicMetaCacheKey(rootAbs, relPath string) string {
	root, err := filepath.Abs(rootAbs)
	if err != nil {
		root = rootAbs
	}
	return strings.ToLower(filepath.Clean(root)) + "|" + filepath.ToSlash(relPath)
}

func cloneLocalMusicTrack(track *localMusicTrack) *localMusicTrack {
	if track == nil {
		return nil
	}
	clone := *track
	clone.Missing = append([]string(nil), track.Missing...)
	clone.Extra = cloneStringMap(track.Extra)
	return &clone
}

func cloneLocalMusicTrackSlice(tracks []*localMusicTrack) []*localMusicTrack {
	result := make([]*localMusicTrack, 0, len(tracks))
	for _, track := range tracks {
		if track != nil {
			result = append(result, cloneLocalMusicTrack(track))
		}
	}
	return result
}

func cloneStringMap(source map[string]string) map[string]string {
	if source == nil {
		return nil
	}
	clone := make(map[string]string, len(source))
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

func localMusicTrackByID(id string) (*localMusicTrack, error) {
	rel, err := decodeLocalMusicID(id)
	if err != nil {
		return nil, err
	}
	cleanRel := filepath.Clean(filepath.FromSlash(strings.TrimSpace(rel)))
	if cleanRel == "." || filepath.IsAbs(cleanRel) || cleanRel == ".." || strings.HasPrefix(cleanRel, ".."+string(filepath.Separator)) {
		return nil, errors.New("invalid local music path")
	}
	root, err := filepath.Abs(localMusicDownloadDir())
	if err != nil {
		return nil, err
	}
	return buildLocalMusicTrack(root, filepath.Join(root, cleanRel))
}

func encodeLocalMusicID(relPath string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(filepath.ToSlash(relPath)))
}

func decodeLocalMusicID(id string) (string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(id))
	return string(raw), err
}

func isPathInside(rootAbs, targetAbs string) bool {
	rel, err := filepath.Rel(rootAbs, targetAbs)
	if err != nil || filepath.IsAbs(rel) {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func containsString(values []string, target string) bool {
	return slices.Contains(values, target)
}

func removeString(values []string, target string) []string {
	return slices.DeleteFunc(append([]string(nil), values...), func(value string) bool { return value == target })
}

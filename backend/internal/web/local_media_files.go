package web

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/fileutil"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/dhowden/tag"
	"github.com/gin-gonic/gin"
)

func saveUploadedLocalMusic(file *multipart.FileHeader) (*localMusicTrack, error) {
	filename, err := sanitizeLocalMusicUploadName(file.Filename)
	if err != nil {
		return nil, err
	}
	dir := localMusicDownloadDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	root, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}

	source, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer source.Close()

	destination, destinationPath, err := createUniqueLocalMusicFile(root, filename)
	if err != nil {
		return nil, err
	}
	copyErr := func() error {
		defer destination.Close()
		_, err := io.Copy(destination, io.LimitReader(source, localMusicMaxUploadBytes+1))
		return err
	}()
	if copyErr != nil {
		_ = os.Remove(destinationPath)
		return nil, copyErr
	}
	info, err := os.Stat(destinationPath)
	if err != nil || info.Size() > localMusicMaxUploadBytes {
		_ = os.Remove(destinationPath)
		if err != nil {
			return nil, err
		}
		return nil, errors.New("文件过大,单个上传上限 200MB")
	}

	track, err := buildLocalMusicTrack(root, destinationPath)
	if err != nil {
		_ = os.Remove(destinationPath)
		return nil, err
	}
	invalidateLocalMusicScanCache()
	return track, nil
}

func createUniqueLocalMusicFile(dir, filename string) (*os.File, string, error) {
	ext := filepath.Ext(filename)
	base := strings.TrimSuffix(filename, ext)
	for sequence := 0; sequence < 10_000; sequence++ {
		name := filename
		if sequence > 0 {
			name = fmt.Sprintf("%s (%d)%s", base, sequence, ext)
		}
		path := filepath.Join(dir, name)
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		return file, path, err
	}
	return nil, "", errors.New("无法为上传文件分配唯一文件名")
}

func sanitizeLocalMusicUploadName(name string) (string, error) {
	name = filepath.Base(strings.ReplaceAll(strings.TrimSpace(name), "\\", "/"))
	ext := strings.ToLower(filepath.Ext(name))
	if _, ok := localMusicAudioExts[ext]; !ok {
		return "", errors.New("仅支持 mp3、flac、m4a、ogg、wav、wma、aac 音频文件")
	}
	base := strings.TrimSpace(fileutil.SanitizeFilename(strings.TrimSuffix(name, filepath.Ext(name))))
	if base == "" {
		base = "local-music"
	}
	return base + ext, nil
}

func uniqueLocalMusicPath(dir, filename string) string {
	ext := filepath.Ext(filename)
	base := strings.TrimSuffix(filename, ext)
	for sequence := 0; ; sequence++ {
		name := filename
		if sequence > 0 {
			name = fmt.Sprintf("%s (%d)%s", base, sequence, ext)
		}
		candidate := filepath.Join(dir, name)
		if _, err := os.Stat(candidate); errors.Is(err, os.ErrNotExist) {
			return candidate
		}
	}
}

type localProbeResult struct {
	Duration int
	Bitrate  int
	Title    string
	Artist   string
	Album    string
}

type localProbePayload struct {
	Format  localProbeStream   `json:"format"`
	Streams []localProbeStream `json:"streams"`
}

type localProbeStream struct {
	CodecType string            `json:"codec_type"`
	Duration  string            `json:"duration"`
	BitRate   string            `json:"bit_rate"`
	Tags      map[string]string `json:"tags"`
}

func probeLocalMusicTrack(track *localMusicTrack) (*localProbeResult, error) {
	if track == nil || strings.TrimSpace(track.absPath) == "" {
		return nil, errors.New("empty local music track")
	}
	ffprobe, err := core.ResolveFFprobePath()
	if err != nil {
		return nil, err
	}
	output, err := exec.Command(
		ffprobe, "-v", "quiet", "-print_format", "json",
		"-show_format", "-show_streams", track.absPath,
	).Output()
	if err != nil {
		return nil, err
	}
	var payload localProbePayload
	if err := json.Unmarshal(output, &payload); err != nil {
		return nil, err
	}
	result := probeResultFromStream(payload.Format)
	for _, stream := range payload.Streams {
		if stream.CodecType != "audio" {
			continue
		}
		mergeProbeResult(result, probeResultFromStream(stream))
		break
	}
	return result, nil
}

func probeResultFromStream(stream localProbeStream) *localProbeResult {
	return &localProbeResult{
		Duration: secondsFromProbe(stream.Duration),
		Bitrate:  kbpsFromProbe(stream.BitRate),
		Title:    probeTag(stream.Tags, "title"),
		Artist:   probeTag(stream.Tags, "artist"),
		Album:    probeTag(stream.Tags, "album"),
	}
}

func mergeProbeResult(target, fallback *localProbeResult) {
	if target.Duration <= 0 {
		target.Duration = fallback.Duration
	}
	if target.Bitrate <= 0 {
		target.Bitrate = fallback.Bitrate
	}
	if target.Title == "" {
		target.Title = fallback.Title
	}
	if target.Artist == "" {
		target.Artist = fallback.Artist
	}
	if target.Album == "" {
		target.Album = fallback.Album
	}
}

func applyLocalProbeResult(track *localMusicTrack, probe *localProbeResult) {
	if track == nil || probe == nil {
		return
	}
	if track.Extra == nil {
		track.Extra = make(map[string]string)
	}
	if probe.Duration > 0 {
		track.Duration = probe.Duration
		track.Extra["duration"] = strconv.Itoa(probe.Duration)
	}
	setMissingMetadata(track, "title", strings.TrimSpace(probe.Title))
	setMissingMetadata(track, "artist", strings.TrimSpace(probe.Artist))
	setMissingMetadata(track, "album", strings.TrimSpace(probe.Album))
	if probe.Bitrate > 0 {
		track.Extra["bitrate"] = strconv.Itoa(probe.Bitrate)
	}
}

func secondsFromProbe(raw string) int {
	seconds, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || seconds <= 0 {
		return 0
	}
	return int(seconds + 0.5)
}

func kbpsFromProbe(raw string) int {
	bitsPerSecond, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || bitsPerSecond <= 0 {
		return 0
	}
	return int(bitsPerSecond / 1000)
}

func probeTag(tags map[string]string, wanted string) string {
	for name, value := range tags {
		if strings.EqualFold(strings.TrimSpace(name), wanted) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func localMusicSidecarFile(audioPath string, extensions []string) (string, string, bool) {
	if path, ext, ok := localMusicExactSidecarFile(audioPath, extensions); ok {
		return path, ext, true
	}
	baseName := strings.TrimSuffix(filepath.Base(audioPath), filepath.Ext(audioPath))
	entries, err := os.ReadDir(filepath.Dir(audioPath))
	if err != nil {
		return "", "", false
	}
	allowed := make(map[string]struct{}, len(extensions))
	for _, ext := range extensions {
		allowed[strings.ToLower(ext)] = struct{}{}
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if _, ok := allowed[ext]; !ok {
			continue
		}
		candidateBase := strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name()))
		if strings.EqualFold(candidateBase, baseName) {
			return filepath.Join(filepath.Dir(audioPath), entry.Name()), ext, true
		}
	}
	return "", "", false
}

func localMusicExactSidecarFile(audioPath string, extensions []string) (string, string, bool) {
	base := strings.TrimSuffix(audioPath, filepath.Ext(audioPath))
	for _, ext := range extensions {
		candidate := base + ext
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, ext, true
		}
	}
	return "", "", false
}

func readLocalMusicPicture(audioPath string) (*tag.Picture, error) {
	file, err := os.Open(audioPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	metadata, err := tag.ReadFrom(file)
	if err != nil {
		return nil, err
	}
	return metadata.Picture(), nil
}

func readLocalMusicLyrics(audioPath string) (string, error) {
	file, err := os.Open(audioPath)
	if err != nil {
		return "", err
	}
	metadata, metadataErr := tag.ReadFrom(file)
	_ = file.Close()
	if metadataErr == nil {
		if lyrics := strings.TrimSpace(metadata.Lyrics()); lyrics != "" {
			return lyrics, nil
		}
	}
	sidecar, _, ok := localMusicSidecarFile(audioPath, localMusicLyricExts)
	if !ok {
		return "", errors.New("local lyric not found")
	}
	data, err := os.ReadFile(sidecar)
	if err != nil {
		return "", err
	}
	lyrics := strings.TrimSpace(string(data))
	if lyrics == "" {
		return "", errors.New("local lyric is empty")
	}
	return lyrics, nil
}

func readLocalMusicCover(track *localMusicTrack) ([]byte, string, string, error) {
	if track == nil {
		return nil, "", "", errors.New("empty local music track")
	}
	if picture, err := readLocalMusicPicture(track.absPath); err == nil && picture != nil && len(picture.Data) > 0 {
		mimeType := strings.TrimSpace(picture.MIMEType)
		if mimeType == "" {
			mimeType = http.DetectContentType(picture.Data)
		}
		if !strings.HasPrefix(mimeType, "image/") {
			mimeType = "image/jpeg"
		}
		return picture.Data, mimeType, imageExtByMime(mimeType), nil
	}
	sidecar, ext, ok := localMusicSidecarFile(track.absPath, localMusicCoverExts)
	if !ok {
		return nil, "", "", errors.New("local cover not found")
	}
	data, err := os.ReadFile(sidecar)
	if err != nil {
		return nil, "", "", err
	}
	return data, localImageMimeByExt(ext), ext, nil
}

func localImageMimeByExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".gif":
		return "image/gif"
	default:
		if detected := mime.TypeByExtension(ext); strings.HasPrefix(detected, "image/") {
			return detected
		}
		return "image/jpeg"
	}
}

func imageExtByMime(mimeType string) string {
	switch strings.ToLower(strings.TrimSpace(mimeType)) {
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/bmp", "image/x-ms-bmp":
		return ".bmp"
	case "image/gif":
		return ".gif"
	default:
		return ".jpg"
	}
}

func localMusicCoverFilename(track *localMusicTrack, ext string) string {
	if strings.TrimSpace(ext) == "" {
		ext = ".jpg"
	}
	return localAssetFilename(track, ext)
}

func localMusicLyricFilename(track *localMusicTrack) string {
	return localAssetFilename(track, ".lrc")
}

func localAssetFilename(track *localMusicTrack, ext string) string {
	name := strings.TrimSpace(track.Name)
	if name == "" {
		name = strings.TrimSuffix(track.Filename, filepath.Ext(track.Filename))
	}
	artist := strings.TrimSpace(track.Artist)
	if artist == "" {
		artist = "Unknown"
	}
	return fileutil.SanitizeFilename(fmt.Sprintf("%s - %s%s", name, artist, ext))
}

func serveLocalMusicLyric(c *gin.Context, song *model.Track, download bool, saveLocal ...bool) {
	track, err := localTrackForLyric(song)
	if err != nil {
		writeMissingLocalLyric(c, download)
		return
	}
	allowed, err := localMusicReadAllowed(c, track)
	if err != nil {
		c.String(http.StatusInternalServerError, "ownership check failed")
		return
	}
	if !allowed {
		writeMissingLocalLyric(c, download)
		return
	}
	lyrics, err := readLocalMusicLyrics(track.absPath)
	if err != nil || strings.TrimSpace(lyrics) == "" {
		writeMissingLocalLyric(c, download)
		return
	}
	lyrics = formatLyricForMode(lyrics, c.DefaultQuery("format", "auto"))
	c.Header("X-Lyric-Format", classifyLyricFormat(lyrics))
	if download {
		if len(saveLocal) > 0 && saveLocal[0] {
			saveWebAssetResponse(c, localMusicLyricFilename(track), []byte(lyrics))
			return
		}
		setDownloadHeader(c, localMusicLyricFilename(track))
	}
	c.String(http.StatusOK, lyrics)
}

func localTrackForLyric(song *model.Track) (*localMusicTrack, error) {
	if song == nil {
		return nil, errors.New("empty song")
	}
	return localMusicTrackByID(song.ID)
}

func writeMissingLocalLyric(c *gin.Context, download bool) {
	if download {
		c.String(http.StatusNotFound, "Lyric not found")
		return
	}
	c.String(http.StatusOK, "[00:00.00] 纯音乐 / 无歌词")
}

func inspectLocalMusicFile(id, fallbackDuration string) (gin.H, error) {
	track, err := localMusicTrackByID(id)
	if err != nil {
		return gin.H{"valid": false}, err
	}
	if probe, err := probeLocalMusicTrack(track); err == nil {
		applyLocalProbeResult(track, probe)
	}
	if root, err := filepath.Abs(localMusicDownloadDir()); err == nil {
		cacheLocalMusicTrack(root, track)
	}
	bitrate := localTrackBitrateText(track, fallbackDuration)
	return gin.H{
		"valid": true, "url": "", "size": track.SizeText,
		"bitrate": bitrate, "duration": track.Duration,
		"song": gin.H{
			"id": track.ID, "source": track.Source, "name": track.Name,
			"artist": track.Artist, "album": track.Album, "cover": track.Cover,
			"duration": track.Duration, "extra": track.Extra,
		},
	}, nil
}

func localTrackBitrateText(track *localMusicTrack, fallbackDuration string) string {
	if kbps, _ := strconv.Atoi(track.Extra["bitrate"]); kbps > 0 {
		return fmt.Sprintf("%d kbps", kbps)
	}
	seconds := track.Duration
	if seconds <= 0 {
		seconds, _ = strconv.Atoi(strings.TrimSpace(fallbackDuration))
	}
	if seconds > 0 && track.Size > 0 {
		return fmt.Sprintf("%d kbps", int((track.Size*8)/int64(seconds)/1000))
	}
	return "-"
}

func localMusicSavedCollectionNames(trackID string, userID uint) ([]string, error) {
	trackID = strings.TrimSpace(trackID)
	if db == nil || trackID == "" {
		return nil, nil
	}
	var collections []Collection
	query := db.Joins("JOIN saved_songs ON saved_songs.collection_id = collections.id").
		Where("saved_songs.song_id = ? AND saved_songs.source IN ?", trackID, []string{localMusicSource, legacyLocalMusicSource})
	if userID > 0 {
		query = query.Where("collections.user_id = ?", userID)
	}
	if err := query.Order("collections.id DESC").Find(&collections).Error; err != nil {
		return nil, err
	}
	names := make([]string, 0, len(collections))
	for _, collection := range collections {
		name := strings.TrimSpace(collection.Name)
		if name == "" {
			name = fmt.Sprintf("歌单 %d", collection.ID)
		}
		names = append(names, name)
	}
	return names, nil
}

func deleteLocalMusicTrackForUser(id string, userID uint, admin bool) error {
	track, err := localMusicTrackByID(id)
	if err != nil {
		return errors.New("本地音乐不存在或已不在下载目录内")
	}
	guardUser := userID
	if admin {
		guardUser = 0
	}
	collections, err := localMusicSavedCollectionNames(track.ID, guardUser)
	if err != nil {
		return err
	}
	if len(collections) > 0 {
		return fmt.Errorf("本地音乐已收藏在：%s。请先从这些自建歌单中取消收藏，再删除本地文件", strings.Join(collections, "、"))
	}
	rel := normalizeRelPath(track.RelPath)
	if admin {
		if err := os.Remove(track.absPath); err != nil {
			return err
		}
		if err := deleteDownloadRecordsByPath(rel); err != nil {
			return fmt.Errorf("文件已删除,清理下载归属失败: %w", err)
		}
		invalidateLocalMusicScanCache()
		return nil
	}

	stillReferenced, err := deleteDownloadRecordForUser(userID, rel)
	if err != nil {
		return err
	}
	if !stillReferenced {
		if err := os.Remove(track.absPath); err != nil {
			// Restore visibility when physical deletion fails after ownership removal.
			_ = recordDownload(userID, rel, localMusicSource, track.ID, track.Name, track.Artist)
			return err
		}
	}
	invalidateLocalMusicScanCache()
	return nil
}

func serveLocalMusicDownload(c *gin.Context, id string, saveLocal bool) {
	track, err := localMusicTrackByID(id)
	if err != nil {
		c.String(http.StatusNotFound, "Local music not found")
		return
	}
	allowed, err := localMusicReadAllowed(c, track)
	if err != nil {
		c.String(http.StatusInternalServerError, "ownership check failed")
		return
	}
	if !allowed {
		c.String(http.StatusNotFound, "Local music not found")
		return
	}
	if saveLocal {
		c.JSON(http.StatusOK, gin.H{
			"status": "ok", "saved": true, "path": track.absPath, "filename": track.Filename,
		})
		return
	}
	file, err := os.Open(track.absPath)
	if err != nil {
		c.String(http.StatusNotFound, "Local music not found")
		return
	}
	defer file.Close()
	c.Header("Content-Type", localAudioMimeByExt(track.Ext))
	setDownloadHeader(c, track.Filename)
	clearWriteDeadline(c)
	http.ServeContent(c.Writer, c.Request, track.Filename, track.modTime, file)
}

func localMusicReadAllowed(c *gin.Context, track *localMusicTrack) (bool, error) {
	if track == nil {
		return false, nil
	}
	if currentUserIsAdmin(c) {
		return true, nil
	}
	owned, err := downloadedRelPathsForUser(currentUserID(c))
	if err != nil {
		return false, err
	}
	_, ok := owned[normalizeRelPath(track.RelPath)]
	return ok, nil
}

func localAudioMimeByExt(ext string) string {
	switch strings.ToLower(strings.TrimPrefix(ext, ".")) {
	case "aac":
		return "audio/aac"
	case "wav":
		return "audio/wav"
	default:
		return core.AudioMimeByExt(ext)
	}
}

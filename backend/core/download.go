package core

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/aki-riko/Melodex/backend/internal/fileutil"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

type DownloadedSong struct {
	Data         []byte
	Ext          string
	ContentType  string
	Filename     string
	SavedPath    string
	Warning      string
	Skipped      bool
	RemovedPaths []string
}

type downloadEnrichment struct {
	lyrics    string
	cover     []byte
	coverMIME string
}

var audioQualityRanks = map[string]int{
	"wma":  0,
	"mp3":  1,
	"ogg":  2,
	"aac":  3,
	"m4a":  3,
	"flac": 5,
	"wav":  5,
}

func audioQualityRank(extension string) int {
	extension = normalizedAudioExtension(extension)
	if rank, known := audioQualityRanks[extension]; known {
		return rank
	}
	return audioQualityRanks["mp3"]
}

func isAudioExt(extension string) bool {
	_, known := audioQualityRanks[normalizedAudioExtension(extension)]
	return known
}

func normalizedAudioExtension(extension string) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(extension), "."))
}

func DownloadSongData(track *model.Track, withCover, withLyrics bool) (*DownloadedSong, error) {
	return DownloadSongDataWithTemplate(track, withCover, withLyrics, DefaultDownloadFilenameTemplate)
}

func DownloadSongDataWithTemplate(track *model.Track, withCover, withLyrics bool, filenameTemplate string) (*DownloadedSong, error) {
	normalized, err := normalizeDownloadTrack(track)
	if err != nil {
		return nil, err
	}
	audio, contentType, err := fetchTrackAudio(normalized)
	if err != nil {
		return nil, err
	}
	if !LooksLikeAudioData(contentType, audio) {
		return nil, fmt.Errorf("upstream response is not audio: %s", contentType)
	}
	extension := identifyDownloadedAudio(audio, contentType)
	enrichment := collectDownloadEnrichment(normalized, withCover, withLyrics)
	finalAudio, warning := enrichDownloadedAudio(audio, extension, normalized, enrichment)
	if extension == "" {
		extension = DetectAudioExt(finalAudio)
	}
	return &DownloadedSong{
		Data:        finalAudio,
		Ext:         extension,
		ContentType: AudioMimeByExt(extension),
		Filename:    BuildDownloadFilename(normalized, extension, filenameTemplate),
		Warning:     warning,
	}, nil
}

func normalizeDownloadTrack(track *model.Track) (*model.Track, error) {
	if track == nil {
		return nil, errors.New("track is nil")
	}
	if strings.TrimSpace(track.ID) == "" || strings.TrimSpace(track.Source) == "" {
		return nil, errors.New("missing track id or source")
	}
	normalized := *track
	normalized.ID = strings.TrimSpace(normalized.ID)
	normalized.Source = strings.TrimSpace(normalized.Source)
	normalized.Name = strings.TrimSpace(normalized.Name)
	normalized.Artist = strings.TrimSpace(normalized.Artist)
	normalized.Album = strings.TrimSpace(normalized.Album)
	if normalized.Name == "" {
		normalized.Name = "Unknown"
	}
	if normalized.Artist == "" {
		normalized.Artist = "Unknown"
	}
	return &normalized, nil
}

func identifyDownloadedAudio(audio []byte, contentType string) string {
	if extension := DetectAudioExtBySignature(audio); extension != "" {
		return extension
	}
	if extension := DetectAudioExtByContentType(contentType); extension != "" {
		return extension
	}
	return DetectAudioExt(audio)
}

func collectDownloadEnrichment(track *model.Track, withCover, withLyrics bool) downloadEnrichment {
	var enrichment downloadEnrichment
	if withLyrics {
		if fetchLyrics := GetLyricFunc(track.Source); fetchLyrics != nil {
			enrichment.lyrics, _ = fetchLyrics(track)
		}
	}
	if withCover && strings.TrimSpace(track.Cover) != "" {
		enrichment.cover, enrichment.coverMIME, _ = FetchResourceBytesWithMime(track.Cover, track.Source)
		if converted, ok := ensureJpegCover(enrichment.cover, enrichment.coverMIME); ok {
			enrichment.cover = converted
			enrichment.coverMIME = "image/jpeg"
		}
	}
	return enrichment
}

func enrichDownloadedAudio(audio []byte, extension string, track *model.Track, enrichment downloadEnrichment) ([]byte, string) {
	if normalizedEmbeddableExtension(extension) == "" ||
		(track.Album == "" && enrichment.lyrics == "" && len(enrichment.cover) == 0) {
		return audio, ""
	}
	embedded, err := EmbedSongMetadata(audio, track, enrichment.lyrics, enrichment.cover, enrichment.coverMIME)
	if err == nil {
		return embedded, ""
	}
	if errors.Is(err, ErrFFmpegNotFound) {
		return audio, "ffmpeg not found, metadata embedding skipped"
	}
	return audio, "metadata embedding failed, using original audio"
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
	outputDirectory = strings.TrimSpace(outputDirectory)
	if outputDirectory == "" {
		outputDirectory = DefaultWebDownloadDir
	}
	outputDirectory = filepath.Clean(outputDirectory)
	if err := os.MkdirAll(outputDirectory, 0o755); err != nil {
		return nil, err
	}

	relativeName := sanitizeDownloadRelativePath(download.Filename)
	targetPath := filepath.Join(outputDirectory, relativeName)
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return nil, err
	}
	existing, err := findSameNameAudioFiles(targetPath)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	newExtension := download.Ext
	if strings.TrimSpace(newExtension) == "" {
		newExtension = filepath.Ext(relativeName)
	}
	newRank := audioQualityRank(newExtension)
	for _, candidate := range existing {
		if audioQualityRank(filepath.Ext(candidate)) >= newRank {
			download.Filename = filepath.Base(candidate)
			download.SavedPath = candidate
			download.Skipped = true
			return download, nil
		}
	}

	if err := os.WriteFile(targetPath, download.Data, 0o644); err != nil {
		return nil, err
	}
	for _, candidate := range existing {
		if candidate == targetPath {
			continue
		}
		if err := os.Remove(candidate); err == nil {
			download.RemovedPaths = append(download.RemovedPaths, candidate)
		}
	}
	download.Filename = relativeName
	download.SavedPath = targetPath
	return download, nil
}

func findSameNameAudioFiles(targetPath string) ([]string, error) {
	directory := filepath.Dir(targetPath)
	targetName := filepath.Base(targetPath)
	targetStem := strings.TrimSuffix(targetName, filepath.Ext(targetName))
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	matches := make([]string, 0)
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() == targetName || !isAudioExt(filepath.Ext(entry.Name())) {
			continue
		}
		if strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())) == targetStem {
			matches = append(matches, filepath.Join(directory, entry.Name()))
		}
	}
	sort.Strings(matches)
	return matches, nil
}

func BuildDownloadFilename(track *model.Track, extension, filenameTemplate string) string {
	filenameTemplate = strings.TrimSpace(filenameTemplate)
	if filenameTemplate == "" {
		filenameTemplate = DefaultDownloadFilenameTemplate
	}
	extension = normalizedAudioExtension(extension)
	values := map[string]string{
		"name": "Unknown", "artist": "Unknown", "album": "", "source": "", "id": "", "ext": extension,
	}
	if track != nil {
		values["name"] = sanitizedTemplateValue(track.Name, "Unknown")
		values["artist"] = sanitizedTemplateValue(track.Artist, "Unknown")
		values["album"] = sanitizedTemplateValue(track.Album, "")
		values["source"] = sanitizedTemplateValue(track.Source, "")
		values["id"] = sanitizedTemplateValue(track.ID, "")
	}
	hasExtensionToken := strings.Contains(filenameTemplate, "{ext}")
	rendered := renderFilenameTemplate(filenameTemplate, values)
	if strings.TrimSpace(rendered) == "" {
		rendered = renderFilenameTemplate(DefaultDownloadFilenameTemplate, values)
	}
	if !hasExtensionToken && extension != "" {
		rendered += "." + extension
	}
	return sanitizeDownloadRelativePath(rendered)
}

func renderFilenameTemplate(template string, values map[string]string) string {
	replacements := make([]string, 0, len(values)*2)
	for _, key := range []string{"name", "artist", "album", "source", "id", "ext"} {
		replacements = append(replacements, "{"+key+"}", values[key])
	}
	return strings.TrimSpace(strings.NewReplacer(replacements...).Replace(template))
}

func sanitizeDownloadRelativePath(name string) string {
	name = strings.ReplaceAll(strings.TrimSpace(name), "\\", "/")
	segments := make([]string, 0)
	for _, segment := range strings.Split(name, "/") {
		segment = sanitizeDownloadPathSegment(segment)
		if segment != "" && segment != "." && segment != ".." {
			segments = append(segments, segment)
		}
	}
	if len(segments) == 0 {
		return "download"
	}
	return filepath.Join(segments...)
}

func sanitizedTemplateValue(value, fallback string) string {
	value = sanitizeDownloadPathSegment(strings.TrimSpace(value))
	if value == "" {
		return fallback
	}
	return value
}

func sanitizeDownloadPathSegment(value string) string {
	value = strings.Trim(value, " .")
	if value == "" {
		return ""
	}
	return strings.Trim(fileutil.SanitizeFilename(value), " .")
}

func fetchTrackAudio(track *model.Track) ([]byte, string, error) {
	if track.Source == "soda" {
		media, err := ResolveProviderMedia(track)
		if err != nil {
			return nil, "", err
		}
		if media.PlayAuth == "" {
			return nil, "", errors.New("provider returned no soda play auth")
		}
		encrypted, _, err := FetchBytesWithMime(media.URL, "soda")
		if err != nil {
			return nil, "", err
		}
		decrypted, err := DecryptSodaAudio(encrypted, media.PlayAuth)
		return decrypted, "", err
	}
	resolve := GetDownloadFunc(track.Source)
	if resolve == nil {
		return nil, "", fmt.Errorf("unsupported source: %s", track.Source)
	}
	mediaURL, err := resolve(track)
	if err != nil {
		return nil, "", err
	}
	if strings.TrimSpace(mediaURL) == "" {
		return nil, "", errors.New("empty download url")
	}
	return FetchBytesWithMime(mediaURL, track.Source)
}

func ensureJpegCover(data []byte, mimeType string) ([]byte, bool) {
	if len(data) == 0 {
		return nil, false
	}
	mimeType = strings.ToLower(strings.TrimSpace(mimeType))
	if mimeType == "" {
		mimeType = http.DetectContentType(data)
	}
	if strings.Contains(mimeType, "jpeg") || strings.Contains(mimeType, "jpg") || strings.Contains(mimeType, "png") {
		return nil, false
	}
	ffmpegPath, err := ResolveFFmpegPath()
	if err != nil {
		return nil, false
	}
	command := exec.Command(ffmpegPath, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "image2", "-c:v", "mjpeg", "-q:v", "3", "pipe:1")
	command.Stdin = bytes.NewReader(data)
	var converted bytes.Buffer
	command.Stdout = &converted
	if err := command.Run(); err != nil || converted.Len() == 0 {
		return nil, false
	}
	return converted.Bytes(), true
}

package core

import (
	"bytes"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"strings"

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

func DownloadSongData(track *model.Track, withCover, withLyrics bool) (*DownloadedSong, error) {
	return DownloadSongDataWithTemplate(track, withCover, withLyrics, DefaultDownloadFilenameTemplate)
}

func DownloadSongDataWithTemplate(track *model.Track, withCover, withLyrics bool, filenameTemplate string) (*DownloadedSong, error) {
	track, err := normalizeDownloadTrack(track)
	if err != nil {
		return nil, err
	}
	audio, contentType, err := fetchTrackAudio(track)
	if err != nil {
		return nil, err
	}
	if !LooksLikeAudioData(contentType, audio) {
		return nil, fmt.Errorf("upstream response is not audio: %s", contentType)
	}
	extension := identifyDownloadedAudio(audio, contentType)
	audio, warning := enrichDownloadedAudio(audio, extension, track, collectDownloadEnrichment(track, withCover, withLyrics))
	if extension == "" {
		extension = DetectAudioExt(audio)
	}
	return &DownloadedSong{
		Data: audio, Ext: extension, ContentType: AudioMimeByExt(extension),
		Filename: BuildDownloadFilename(track, extension, filenameTemplate), Warning: warning,
	}, nil
}

func normalizeDownloadTrack(input *model.Track) (*model.Track, error) {
	if input == nil {
		return nil, errors.New("track is nil")
	}
	track := *input
	track.ID, track.Source = strings.TrimSpace(track.ID), strings.TrimSpace(track.Source)
	if track.ID == "" || track.Source == "" {
		return nil, errors.New("missing track id or source")
	}
	track.Name = textOrFallback(track.Name, "Unknown")
	track.Artist = textOrFallback(track.Artist, "Unknown")
	track.Album = strings.TrimSpace(track.Album)
	return &track, nil
}

func textOrFallback(value, fallback string) string {
	if value = strings.TrimSpace(value); value != "" {
		return value
	}
	return fallback
}

func identifyDownloadedAudio(audio []byte, contentType string) string {
	detectors := []func() string{
		func() string { return DetectAudioExtBySignature(audio) },
		func() string { return DetectAudioExtByContentType(contentType) },
		func() string { return DetectAudioExt(audio) },
	}
	for _, detect := range detectors {
		if extension := detect(); extension != "" {
			return extension
		}
	}
	return ""
}

func collectDownloadEnrichment(track *model.Track, withCover, withLyrics bool) downloadEnrichment {
	var enrichment downloadEnrichment
	if withLyrics {
		if fetch := GetLyricFunc(track.Source); fetch != nil {
			lyrics, err := fetch(track)
			if err != nil {
				log.Printf("[download] fetch lyrics source=%q id=%q: %v", track.Source, track.ID, err)
			} else {
				enrichment.lyrics = lyrics
			}
		}
	}
	if withCover && strings.TrimSpace(track.Cover) != "" {
		cover, mimeType, err := FetchResourceBytesWithMime(track.Cover, track.Source)
		if err != nil {
			log.Printf("[download] fetch cover source=%q id=%q: %v", track.Source, track.ID, err)
			return enrichment
		}
		enrichment.cover, enrichment.coverMIME = cover, mimeType
		if jpeg, converted := ensureJpegCover(cover, mimeType); converted {
			enrichment.cover, enrichment.coverMIME = jpeg, "image/jpeg"
		}
	}
	return enrichment
}

func enrichDownloadedAudio(audio []byte, extension string, track *model.Track, enrichment downloadEnrichment) ([]byte, string) {
	needsMetadata := track.Album != "" || enrichment.lyrics != "" || len(enrichment.cover) > 0
	if !needsMetadata || normalizedEmbeddableExtension(extension) == "" {
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

func fetchTrackAudio(track *model.Track) ([]byte, string, error) {
	if track.Source == "soda" {
		media, err := ResolveProviderMedia(track)
		if err != nil {
			return nil, "", err
		}
		if media.PlayAuth == "" {
			return nil, "", errors.New("provider returned no soda play auth")
		}
		encrypted, _, err := FetchBytesWithMime(media.URL, track.Source)
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
	if mimeType = strings.ToLower(strings.TrimSpace(mimeType)); mimeType == "" {
		mimeType = http.DetectContentType(data)
	}
	if strings.Contains(mimeType, "jpeg") || strings.Contains(mimeType, "jpg") || strings.Contains(mimeType, "png") {
		return nil, false
	}
	ffmpeg, err := ResolveFFmpegPath()
	if err != nil {
		return nil, false
	}
	command := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "image2", "-c:v", "mjpeg", "-q:v", "3", "pipe:1")
	command.Stdin = bytes.NewReader(data)
	var output bytes.Buffer
	command.Stdout = &output
	if err := command.Run(); err != nil || output.Len() == 0 {
		return nil, false
	}
	return output.Bytes(), true
}

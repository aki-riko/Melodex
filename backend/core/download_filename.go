package core

import (
	"path/filepath"
	"strings"

	"github.com/aki-riko/Melodex/backend/internal/fileutil"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

var filenameTemplateKeys = []string{"name", "artist", "album", "source", "id", "ext"}

func BuildDownloadFilename(track *model.Track, extension, template string) string {
	if template = strings.TrimSpace(template); template == "" {
		template = DefaultDownloadFilenameTemplate
	}
	extension = normalizedAudioExtension(extension)
	values := filenameTemplateValues(track, extension)
	containsExtension := strings.Contains(template, "{ext}")
	filename := applyFilenameTemplate(template, values)
	if filename == "" {
		filename = applyFilenameTemplate(DefaultDownloadFilenameTemplate, values)
	}
	if !containsExtension && extension != "" {
		filename += "." + extension
	}
	return sanitizeDownloadRelativePath(filename)
}

func filenameTemplateValues(track *model.Track, extension string) map[string]string {
	values := map[string]string{
		"name": "Unknown", "artist": "Unknown", "album": "",
		"source": "", "id": "", "ext": extension,
	}
	if track == nil {
		return values
	}
	values["name"] = sanitizedTemplateValue(track.Name, "Unknown")
	values["artist"] = sanitizedTemplateValue(track.Artist, "Unknown")
	values["album"] = sanitizedTemplateValue(track.Album, "")
	values["source"] = sanitizedTemplateValue(track.Source, "")
	values["id"] = sanitizedTemplateValue(track.ID, "")
	return values
}

func applyFilenameTemplate(template string, values map[string]string) string {
	pairs := make([]string, 0, len(filenameTemplateKeys)*2)
	for _, key := range filenameTemplateKeys {
		pairs = append(pairs, "{"+key+"}", values[key])
	}
	return strings.TrimSpace(strings.NewReplacer(pairs...).Replace(template))
}

func sanitizeDownloadRelativePath(value string) string {
	value = strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	segments := make([]string, 0)
	for _, raw := range strings.Split(value, "/") {
		segment := sanitizeDownloadPathSegment(raw)
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
	if value = sanitizeDownloadPathSegment(value); value != "" {
		return value
	}
	return fallback
}

func sanitizeDownloadPathSegment(value string) string {
	value = strings.Trim(strings.TrimSpace(value), " .")
	if value == "" {
		return ""
	}
	return strings.Trim(fileutil.SanitizeFilename(value), " .")
}

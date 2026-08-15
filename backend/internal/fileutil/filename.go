package fileutil

import "strings"

var invalidFilenameCharacters = strings.NewReplacer(
	"\\", "_",
	"/", "_",
	":", "_",
	"*", "_",
	"?", "_",
	"\"", "_",
	"<", "_",
	">", "_",
	"|", "_",
)

func SanitizeFilename(name string) string {
	name = strings.TrimSpace(invalidFilenameCharacters.Replace(name))
	if name == "" {
		return "unknown"
	}
	return name
}

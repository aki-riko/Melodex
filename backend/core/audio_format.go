package core

import (
	"bytes"
	"fmt"
	"strings"
)

type fixedAudioSignature struct {
	ext    string
	offset int
	bytes  []byte
}

var fixedAudioSignatures = []fixedAudioSignature{
	{ext: "wma", bytes: []byte{0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C}},
	{ext: "flac", bytes: []byte("fLaC")},
	{ext: "mp3", bytes: []byte("ID3")},
	{ext: "ogg", bytes: []byte("OggS")},
	{ext: "m4a", offset: 4, bytes: []byte("ftyp")},
}

var audioExtensionByContentType = map[string]string{
	"audio/flac": "flac", "audio/x-flac": "flac",
	"audio/x-ms-wma": "wma", "audio/wma": "wma", "video/x-ms-asf": "wma", "application/vnd.ms-asf": "wma",
	"audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/x-mp3": "mp3",
	"audio/ogg": "ogg", "application/ogg": "ogg",
	"audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "m4a", "audio/aacp": "m4a",
}

var audioMIMEByExtension = map[string]string{
	"wma":  "audio/x-ms-wma",
	"flac": "audio/flac",
	"ogg":  "audio/ogg",
	"m4a":  "audio/mp4",
	"wav":  "audio/wav",
	"mp3":  "audio/mpeg",
}

func FormatSize(size int64) string {
	if size <= 0 {
		return "-"
	}
	return fmt.Sprintf("%.1f MB", float64(size)/(1024*1024))
}

func DetectAudioExt(data []byte) string {
	if extension := DetectAudioExtBySignature(data); extension != "" {
		return extension
	}
	return "mp3"
}

func DetectAudioExtBySignature(data []byte) string {
	for _, signature := range fixedAudioSignatures {
		end := signature.offset + len(signature.bytes)
		if end <= len(data) && bytes.Equal(data[signature.offset:end], signature.bytes) {
			return signature.ext
		}
	}
	if len(data) >= 2 && data[0] == 0xFF && data[1]&0xE0 == 0xE0 {
		return "mp3"
	}
	if len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WAVE")) {
		return "wav"
	}
	return ""
}

func DetectAudioExtByContentType(contentType string) string {
	contentType, _, _ = strings.Cut(strings.ToLower(strings.TrimSpace(contentType)), ";")
	return audioExtensionByContentType[strings.TrimSpace(contentType)]
}

func LooksLikeAudioData(contentType string, data []byte) bool {
	if len(data) == 0 {
		return false
	}
	if DetectAudioExtBySignature(data) != "" {
		return true
	}
	return DetectAudioExtByContentType(contentType) != "" && !looksLikeTextResponse(data)
}

func looksLikeTextResponse(data []byte) bool {
	if len(data) == 0 {
		return false
	}
	probeLength := min(len(data), 64)
	probe := strings.TrimLeft(strings.ToLower(string(data[:probeLength])), " \t\r\n\x00")
	for _, prefix := range []string{"<!doctype", "<html", "<", "{", "[", "error", "failed", "upstream"} {
		if strings.HasPrefix(probe, prefix) {
			return true
		}
	}
	return false
}

func AudioMimeByExt(extension string) string {
	if mimeType := audioMIMEByExtension[strings.ToLower(strings.TrimSpace(extension))]; mimeType != "" {
		return mimeType
	}
	return "audio/mpeg"
}

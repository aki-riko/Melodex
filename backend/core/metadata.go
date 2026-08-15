package core

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/dhowden/tag"
)

var ErrFFmpegNotFound = errors.New("ffmpeg not found")

const id3HeaderLength = 10

type embeddedMetadata struct {
	title     string
	artist    string
	album     string
	lyrics    string
	cover     []byte
	coverMIME string
}

func decodeID3SynchsafeSize(data []byte) (int, bool) {
	if len(data) < 4 {
		return 0, false
	}
	value := 0
	for _, part := range data[:4] {
		if part >= 0x80 {
			return 0, false
		}
		value = value*0x80 + int(part)
	}
	return value, true
}

func id3SynchsafeSize(size int) [4]byte {
	var encoded [4]byte
	remaining := uint(size)
	for index := len(encoded) - 1; index >= 0; index-- {
		encoded[index] = byte(remaining % 0x80)
		remaining /= 0x80
	}
	return encoded
}

func id3TagEnd(audio []byte) (int, bool) {
	if len(audio) < id3HeaderLength || string(audio[:3]) != "ID3" {
		return 0, false
	}
	payloadSize, validSize := decodeID3SynchsafeSize(audio[6:id3HeaderLength])
	if !validSize {
		return 0, false
	}
	end := id3HeaderLength + payloadSize
	if audio[5]&0x10 != 0 {
		end += id3HeaderLength
	}
	if end < id3HeaderLength || end > len(audio) {
		return 0, false
	}
	return end, true
}

func stripID3v2Prefix(audio []byte) []byte {
	if end, ok := id3TagEnd(audio); ok {
		return audio[end:]
	}
	return audio
}

func id3UTF16LEText(value string) []byte {
	units := utf16.Encode([]rune(value))
	encoded := make([]byte, 2+len(units)*2)
	copy(encoded, []byte{0xFF, 0xFE})
	for index, unit := range units {
		binary.LittleEndian.PutUint16(encoded[2+index*2:], unit)
	}
	return encoded
}

func id3TextFramePayload(value string) []byte {
	return append([]byte{0x01}, id3UTF16LEText(value)...)
}

func id3USLTPayload(lyrics string) []byte {
	var payload bytes.Buffer
	payload.Write([]byte{0x01, 'e', 'n', 'g', 0xFF, 0xFE, 0x00, 0x00})
	payload.Write(id3UTF16LEText(lyrics))
	return payload.Bytes()
}

func id3APICPayload(cover []byte, coverMIME string) []byte {
	var payload bytes.Buffer
	payload.Grow(4 + len(coverMIME) + len(cover))
	payload.WriteByte(0x00)
	payload.WriteString(normalizeCoverMime(coverMIME))
	payload.Write([]byte{0x00, 0x03, 0x00})
	payload.Write(cover)
	return payload.Bytes()
}

func id3v23Frame(identifier string, payload []byte) []byte {
	if len(identifier) != 4 || len(payload) == 0 {
		return nil
	}
	header := [id3HeaderLength]byte{}
	copy(header[:4], identifier)
	binary.BigEndian.PutUint32(header[4:8], uint32(len(payload)))
	frame := make([]byte, len(header)+len(payload))
	copy(frame, header[:])
	copy(frame[len(header):], payload)
	return frame
}

func validID3FrameIdentifier(identifier []byte) bool {
	if len(identifier) != 4 {
		return false
	}
	for _, character := range identifier {
		letter := character >= 'A' && character <= 'Z'
		digit := character >= '0' && character <= '9'
		if !letter && !digit {
			return false
		}
	}
	return true
}

type id3FrameCursor struct {
	data   []byte
	offset int
}

func (cursor *id3FrameCursor) next() (string, []byte, bool) {
	if cursor == nil || cursor.offset+id3HeaderLength > len(cursor.data) {
		return "", nil, false
	}
	header := cursor.data[cursor.offset : cursor.offset+id3HeaderLength]
	if !validID3FrameIdentifier(header[:4]) {
		return "", nil, false
	}
	payloadSize := int(binary.BigEndian.Uint32(header[4:8]))
	frameEnd := cursor.offset + id3HeaderLength + payloadSize
	if payloadSize <= 0 || frameEnd > len(cursor.data) {
		return "", nil, false
	}
	start := cursor.offset
	cursor.offset = frameEnd
	return string(header[:4]), cursor.data[start:frameEnd], true
}

func preservedID3v23Frames(audio []byte, replacements map[string]bool) []byte {
	end, valid := id3TagEnd(audio)
	if !valid || audio[3] != 0x03 || audio[5]&0x40 != 0 {
		return nil
	}
	cursor := id3FrameCursor{data: audio[id3HeaderLength:end]}
	preserved := make([]byte, 0, len(cursor.data))
	for {
		identifier, rawFrame, ok := cursor.next()
		if !ok {
			return preserved
		}
		if !replacements[identifier] {
			preserved = append(preserved, rawFrame...)
		}
	}
}

func embedMP3ID3v23Metadata(audio []byte, title, artist, album, lyrics string, cover []byte, coverMIME string) ([]byte, error) {
	values := map[string]string{"TIT2": title, "TPE1": artist, "TPE2": artist, "TALB": album, "USLT": lyrics}
	replacements := make(map[string]bool, len(values)+1)
	for identifier, value := range values {
		replacements[identifier] = value != ""
	}
	replacements["APIC"] = len(cover) != 0

	var frames bytes.Buffer
	frames.Write(preservedID3v23Frames(audio, replacements))
	for _, identifier := range []string{"TIT2", "TPE1", "TPE2", "TALB", "USLT"} {
		value := values[identifier]
		if value == "" {
			continue
		}
		encode := id3TextFramePayload
		if identifier == "USLT" {
			encode = id3USLTPayload
		}
		frames.Write(id3v23Frame(identifier, encode(value)))
	}
	if len(cover) > 0 {
		frames.Write(id3v23Frame("APIC", id3APICPayload(cover, coverMIME)))
	}
	if frames.Len() == 0 {
		return audio, nil
	}

	header := [id3HeaderLength]byte{'I', 'D', '3', 0x03}
	encodedSize := id3SynchsafeSize(frames.Len())
	copy(header[6:], encodedSize[:])
	output := make([]byte, 0, len(header)+frames.Len()+len(audio))
	output = append(output, header[:]...)
	output = append(output, frames.Bytes()...)
	output = append(output, stripID3v2Prefix(audio)...)
	return output, nil
}

func normalizeCoverMime(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	switch {
	case strings.Contains(value, "png"):
		return "image/png"
	case strings.Contains(value, "webp"):
		return "image/webp"
	case strings.Contains(value, "gif"):
		return "image/gif"
	default:
		return "image/jpeg"
	}
}

func EmbedSongMetadata(audio []byte, track *model.Track, lyrics string, cover []byte, coverMIME string) ([]byte, error) {
	if len(audio) == 0 {
		return nil, errors.New("empty audio data")
	}
	metadata := embeddedMetadata{
		lyrics: strings.TrimSpace(lyrics), cover: append([]byte(nil), cover...), coverMIME: normalizeCoverMime(coverMIME),
	}
	extension := DetectAudioExt(audio)
	if track != nil {
		metadata.title = strings.TrimSpace(track.Name)
		metadata.artist = strings.TrimSpace(track.Artist)
		metadata.album = strings.TrimSpace(track.Album)
		if requested := normalizedEmbeddableExtension(track.Ext); requested != "" {
			extension = requested
		}
	}
	mergeExistingMetadata(audio, extension, &metadata)
	if extension != "mp3" && extension != "flac" && extension != "m4a" && extension != "wma" {
		return audio, nil
	}
	if metadata.title == "" && metadata.artist == "" && metadata.album == "" && metadata.lyrics == "" && len(metadata.cover) == 0 {
		return audio, nil
	}
	if extension == "mp3" {
		return embedMP3ID3v23Metadata(audio, metadata.title, metadata.artist, metadata.album, metadata.lyrics, metadata.cover, metadata.coverMIME)
	}
	return embedAudioMetadataByFFmpeg(audio, extension, metadata.title, metadata.artist, metadata.album, metadata.lyrics, metadata.cover, metadata.coverMIME)
}

func normalizedEmbeddableExtension(value string) string {
	value = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(value), "."))
	switch value {
	case "mp3", "flac", "m4a", "wma":
		return value
	default:
		return ""
	}
}

func mergeExistingMetadata(audio []byte, extension string, metadata *embeddedMetadata) {
	existing, err := tag.ReadFrom(bytes.NewReader(audio))
	if err != nil {
		return
	}
	if metadata.title == "" {
		metadata.title = strings.TrimSpace(existing.Title())
	}
	if metadata.artist == "" {
		metadata.artist = strings.TrimSpace(existing.Artist())
	}
	if metadata.album == "" {
		metadata.album = strings.TrimSpace(existing.Album())
	}
	if metadata.lyrics == "" {
		metadata.lyrics = strings.TrimSpace(existing.Lyrics())
	}
	if extension == "mp3" && len(metadata.cover) == 0 {
		if picture := existing.Picture(); picture != nil && len(picture.Data) > 0 {
			metadata.cover = append([]byte(nil), picture.Data...)
			if picture.MIMEType != "" {
				metadata.coverMIME = picture.MIMEType
			}
		}
	}
}

func embedAudioMetadataByFFmpeg(audio []byte, extension, title, artist, album, lyrics string, cover []byte, coverMIME string) ([]byte, error) {
	ffmpegPath, err := ResolveFFmpegPath()
	if err != nil {
		return nil, ErrFFmpegNotFound
	}
	inputPath, removeInput, err := writeTemporaryMedia("melodex-in-*"+"."+extension, audio)
	if err != nil {
		return nil, err
	}
	defer removeInput()
	outputPath, removeOutput, err := reserveTemporaryMedia("melodex-out-*" + "." + extension)
	if err != nil {
		return nil, err
	}
	defer removeOutput()

	arguments := []string{"-y", "-hide_banner", "-loglevel", "error", "-i", inputPath}
	if len(cover) > 0 {
		coverExtension := ".jpg"
		if normalizeCoverMime(coverMIME) == "image/png" {
			coverExtension = ".png"
		}
		coverPath, removeCover, err := writeTemporaryMedia("melodex-cover-*"+coverExtension, cover)
		if err != nil {
			return nil, err
		}
		defer removeCover()
		arguments = append(arguments, "-i", coverPath, "-map", "0:a:0", "-map", "1:v:0", "-map_metadata", "0", "-c:a", "copy", "-c:v", "copy", "-disposition:v:0", "attached_pic", "-metadata:s:v:0", "title=Album cover", "-metadata:s:v:0", "comment=Cover (front)")
	} else {
		arguments = append(arguments, "-map", "0", "-map_metadata", "0", "-c", "copy")
	}
	for _, entry := range []struct{ key, value string }{
		{key: "title", value: title}, {key: "artist", value: artist}, {key: "album_artist", value: artist},
		{key: "album", value: album}, {key: "lyrics", value: lyrics},
	} {
		if entry.value != "" {
			arguments = append(arguments, "-metadata", entry.key+"="+entry.value)
		}
	}
	arguments = append(arguments, outputPath)
	commandOutput, err := exec.Command(ffmpegPath, arguments...).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("ffmpeg metadata embed failed: %v, output: %s", err, strings.TrimSpace(string(commandOutput)))
	}
	embedded, err := os.ReadFile(filepath.Clean(outputPath))
	if err != nil {
		return nil, err
	}
	if len(embedded) == 0 {
		return nil, errors.New("embedded output is empty")
	}
	return embedded, nil
}

func writeTemporaryMedia(pattern string, data []byte) (string, func(), error) {
	file, err := os.CreateTemp("", pattern)
	if err != nil {
		return "", func() {}, err
	}
	path := file.Name()
	cleanup := func() { _ = os.Remove(path) }
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		cleanup()
		return "", func() {}, err
	}
	if err := file.Close(); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return path, cleanup, nil
}

func reserveTemporaryMedia(pattern string) (string, func(), error) {
	file, err := os.CreateTemp("", pattern)
	if err != nil {
		return "", func() {}, err
	}
	path := file.Name()
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", func() {}, err
	}
	return path, func() { _ = os.Remove(path) }, nil
}

package core

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/dhowden/tag"
)

func readEmbeddedMetadata(t *testing.T, data []byte) tag.Metadata {
	t.Helper()
	metadata, err := tag.ReadFrom(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("read embedded metadata: %v", err)
	}
	return metadata
}

func TestMP3MetadataEmbeddingContract(t *testing.T) {
	audioFrames := []byte{0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0}
	cover := []byte{0xff, 0xd8, 0xff, 0xd9}
	track := &model.Track{Name: "测试歌", Artist: "测试歌手", Album: "测试专辑", Ext: "mp3"}
	embedded, err := EmbedSongMetadata(audioFrames, track, "[00:01.00]歌词测试", cover, "image/jpeg")
	if err != nil {
		t.Fatalf("embed MP3 metadata: %v", err)
	}
	if bytes.HasPrefix(embedded, audioFrames) || !bytes.HasSuffix(embedded, audioFrames) {
		t.Fatal("MP3 metadata did not prepend an ID3 tag while retaining audio frames")
	}
	metadata := readEmbeddedMetadata(t, embedded)
	if metadata.Format() != tag.ID3v2_3 || metadata.Title() != track.Name || metadata.Artist() != track.Artist || metadata.Album() != track.Album {
		t.Fatalf("embedded MP3 fields = %v/%q/%q/%q", metadata.Format(), metadata.Title(), metadata.Artist(), metadata.Album())
	}
	if metadata.Lyrics() != "[00:01.00]歌词测试" {
		t.Fatalf("embedded lyrics = %q", metadata.Lyrics())
	}
	if picture := metadata.Picture(); picture == nil || !bytes.Equal(picture.Data, cover) {
		t.Fatalf("embedded cover = %#v", picture)
	}
}

func TestMP3MetadataReplacementAndPreservation(t *testing.T) {
	audioFrames := []byte{0xff, 0xfb, 0x90, 0x64}
	cover := []byte{0xff, 0xd8, 0xff, 0xd9}
	first, err := EmbedSongMetadata(audioFrames, &model.Track{Name: "旧歌", Artist: "旧歌手", Album: "旧专辑", Ext: "mp3"}, "旧歌词", cover, "image/jpeg")
	if err != nil {
		t.Fatalf("embed initial metadata: %v", err)
	}

	replaced, err := EmbedSongMetadata(first, &model.Track{Name: "新歌", Artist: "新歌手", Album: "新专辑", Ext: "mp3"}, "新歌词", nil, "")
	if err != nil {
		t.Fatalf("replace metadata: %v", err)
	}
	replacedMetadata := readEmbeddedMetadata(t, replaced)
	if replacedMetadata.Title() != "新歌" || replacedMetadata.Artist() != "新歌手" || replacedMetadata.Album() != "新专辑" || replacedMetadata.Lyrics() != "新歌词" {
		t.Fatalf("replacement fields = %q/%q/%q/%q", replacedMetadata.Title(), replacedMetadata.Artist(), replacedMetadata.Album(), replacedMetadata.Lyrics())
	}
	if !bytes.HasSuffix(replaced, audioFrames) {
		t.Fatal("replacement lost original MP3 frames")
	}

	preserved, err := EmbedSongMetadata(first, &model.Track{Name: "新歌", Artist: "新歌手", Ext: "mp3"}, "", nil, "")
	if err != nil {
		t.Fatalf("preserve omitted metadata: %v", err)
	}
	preservedMetadata := readEmbeddedMetadata(t, preserved)
	if preservedMetadata.Album() != "旧专辑" || preservedMetadata.Lyrics() != "旧歌词" {
		t.Fatalf("omitted album/lyrics were not preserved: %q/%q", preservedMetadata.Album(), preservedMetadata.Lyrics())
	}
	if picture := preservedMetadata.Picture(); picture == nil || !bytes.Equal(picture.Data, cover) {
		t.Fatalf("omitted cover was not preserved: %#v", picture)
	}
}

func TestMP3MetadataKeepsUnmodifiedFrames(t *testing.T) {
	audioFrames := []byte{0xff, 0xfb, 0x90, 0x64}
	var frames bytes.Buffer
	frames.Write(id3v23Frame("TCON", id3TextFramePayload("Rock")))
	frames.Write(id3v23Frame("TRCK", id3TextFramePayload("7")))
	tagSize := id3SynchsafeSize(frames.Len())
	tagged := append([]byte{'I', 'D', '3', 3, 0, 0}, tagSize[:]...)
	tagged = append(tagged, frames.Bytes()...)
	tagged = append(tagged, audioFrames...)

	embedded, err := EmbedSongMetadata(tagged, &model.Track{Name: "New Title", Artist: "New Artist", Album: "New Album", Ext: "mp3"}, "New lyric", nil, "")
	if err != nil {
		t.Fatalf("update selected ID3 frames: %v", err)
	}
	metadata := readEmbeddedMetadata(t, embedded)
	trackNumber, _ := metadata.Track()
	if metadata.Genre() != "Rock" || trackNumber != 7 {
		t.Fatalf("preserved genre/track = %q/%d", metadata.Genre(), trackNumber)
	}
}

func TestFLACMetadataKeepsUnmodifiedFields(t *testing.T) {
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not available")
	}
	inPath := filepath.Join(t.TempDir(), "source.flac")
	cmd := exec.Command(ffmpegPath, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "0.05", "-metadata", "title=Old Title", "-metadata", "artist=Old Artist", "-metadata", "album=Old Album", "-metadata", "genre=Jazz", inPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create FLAC fixture: %v, output: %s", err, output)
	}
	audioData, err := os.ReadFile(inPath)
	if err != nil {
		t.Fatalf("read FLAC fixture: %v", err)
	}
	embedded, err := EmbedSongMetadata(audioData, &model.Track{Album: "New Album", Ext: "flac"}, "", nil, "")
	if err != nil {
		t.Fatalf("update FLAC album: %v", err)
	}
	metadata := readEmbeddedMetadata(t, embedded)
	if metadata.Title() != "Old Title" || metadata.Artist() != "Old Artist" || metadata.Album() != "New Album" || metadata.Genre() != "Jazz" {
		t.Fatalf("FLAC fields = %q/%q/%q/%q", metadata.Title(), metadata.Artist(), metadata.Album(), metadata.Genre())
	}
}

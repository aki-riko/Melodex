package core

import (
	"os"
	"path/filepath"
	"testing"
)

// 这组测试锁定「同格式按体积升级」的行为:早期只比扩展名 rank,导致
// 128k mp3 遇到 320k mp3 被判为无需升级,旧的低码率文件被永久保留。

func TestDownloadCandidateIsNotBetterSameExtensionBySize(t *testing.T) {
	root := t.TempDir()
	existing := filepath.Join(root, "歌.flac")
	if err := os.WriteFile(existing, []byte("x"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// 无损同档:不比体积,永远认为已有版本足够(避免 flac 之间无谓替换)。
	if !downloadCandidateIsNotBetter(existing, "flac", 1<<30) {
		t.Fatal("lossless same-rank replacement must be rejected regardless of size")
	}
}

func TestDownloadCandidateIsNotBetterBitrateUpgrade(t *testing.T) {
	root := t.TempDir()
	oldMP3 := filepath.Join(root, "歌.mp3")
	// 128k 档的典型现场:文件很小。
	oldData := make([]byte, 3_000_000)
	if err := os.WriteFile(oldMP3, oldData, 0o644); err != nil {
		t.Fatalf("seed old mp3: %v", err)
	}

	// 320k 明显更大 → 必须被认为是"更好",不能跳过。
	if downloadCandidateIsNotBetter(oldMP3, "mp3", int64(len(oldData))*2) {
		t.Fatal("a much larger same-extension candidate must be accepted as an upgrade")
	}

	// 体积几乎相同(仅元数据差异)→ 不重复重写。
	if !downloadCandidateIsNotBetter(oldMP3, "mp3", int64(len(oldData))) {
		t.Fatal("an equal-size candidate must not be treated as an upgrade")
	}

	// 略大但在阈值内(嵌封面/歌词造成的膨胀)→ 不重复重写。
	slightlyLarger := int64(float64(len(oldData)) * 1.1)
	if !downloadCandidateIsNotBetter(oldMP3, "mp3", slightlyLarger) {
		t.Fatal("metadata-sized growth must not trigger a rewrite")
	}
}

func TestDownloadCandidateIsNotBetterExtensionRank(t *testing.T) {
	root := t.TempDir()
	flacPath := filepath.Join(root, "歌.flac")
	if err := os.WriteFile(flacPath, []byte("lossless"), 0o644); err != nil {
		t.Fatalf("seed flac: %v", err)
	}
	// 已有无损、来的是有损:不替换(即使新文件更大)。
	if !downloadCandidateIsNotBetter(flacPath, "mp3", 1<<30) {
		t.Fatal("lower-rank candidate must not replace a lossless file")
	}

	mp3Path := filepath.Join(root, "歌2.mp3")
	if err := os.WriteFile(mp3Path, []byte("lossy"), 0o644); err != nil {
		t.Fatalf("seed mp3: %v", err)
	}
	// 已有有损、来的是无损:替换。
	if downloadCandidateIsNotBetter(mp3Path, "flac", 1<<20) {
		t.Fatal("higher-rank candidate must replace a lossy file")
	}
}

func TestSaveDownloadUpgradesSameFormatBySize(t *testing.T) {
	root := t.TempDir()
	oldMP3 := filepath.Join(root, "歌名 - 歌手.mp3")
	oldData := make([]byte, 3_000_000)
	if err := os.WriteFile(oldMP3, oldData, 0o644); err != nil {
		t.Fatalf("seed old mp3: %v", err)
	}

	newData := make([]byte, 8_000_000)
	result, err := saveDownloadedSongToFile(
		&DownloadedSong{Data: newData, Ext: "mp3", Filename: "歌名 - 歌手.mp3"}, root)
	if err != nil {
		t.Fatalf("save upgrade: %v", err)
	}
	if result.Skipped {
		t.Fatal("a significantly larger same-format download must replace the old file")
	}
	data, readErr := os.ReadFile(oldMP3)
	if readErr != nil {
		t.Fatalf("read upgraded file: %v", readErr)
	}
	if len(data) != len(newData) {
		t.Fatalf("file size=%d, want upgraded %d", len(data), len(newData))
	}
}

func TestSaveDownloadKeepsEqualSizeSameFormat(t *testing.T) {
	root := t.TempDir()
	oldMP3 := filepath.Join(root, "歌名 - 歌手.mp3")
	oldData := make([]byte, 4_000_000)
	if err := os.WriteFile(oldMP3, oldData, 0o644); err != nil {
		t.Fatalf("seed old mp3: %v", err)
	}

	// 同 stem、不同扩展名(both lossy)且体积相仿 → 视为不升级,保留旧文件。
	// (完全同名的重下不走这条判定,见 TestSaveDownloadOverwritesIdenticalName。)
	result, err := saveDownloadedSongToFile(
		&DownloadedSong{Data: make([]byte, 4_000_000), Ext: "ogg", Filename: "歌名 - 歌手.ogg"}, root)
	if err != nil {
		t.Fatalf("save duplicate: %v", err)
	}
	if !result.Skipped {
		t.Fatal("an equal-size lossy variant must not replace the existing file")
	}
	if result.SavedPath != oldMP3 {
		t.Fatalf("kept path=%q, want %q", result.SavedPath, oldMP3)
	}
}

// 完全同名的重下会无条件覆盖:这是刻意行为,让损坏/截断的旧文件能被一次
// 正常下载修好(findSameNameAudioFiles 把 target 自身排除在 versions 之外)。
func TestSaveDownloadOverwritesIdenticalName(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "歌名 - 歌手.mp3")
	if err := os.WriteFile(target, make([]byte, 3_000_000), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	result, err := saveDownloadedSongToFile(
		&DownloadedSong{Data: make([]byte, 3_000_000), Ext: "mp3", Filename: "歌名 - 歌手.mp3"}, root)
	if err != nil {
		t.Fatalf("save same name: %v", err)
	}
	if result.Skipped {
		t.Fatal("identical-name download must overwrite (repairs truncated files)")
	}
}

// 回归:旧实现用编码格式序当音质序(ogg=2 > mp3=1),会把 320k mp3 换成
// 128k ogg —— 用更小的文件替换更好的音频。必须禁止。
func TestSaveDownloadDoesNotDowngradeMp3ToSmallerOgg(t *testing.T) {
	root := t.TempDir()
	oldMP3 := filepath.Join(root, "歌名 - 歌手.mp3")
	oldData := make([]byte, 8_000_000) // 320k 档的体积
	if err := os.WriteFile(oldMP3, oldData, 0o644); err != nil {
		t.Fatalf("seed 320k mp3: %v", err)
	}

	result, err := saveDownloadedSongToFile(
		&DownloadedSong{Data: make([]byte, 3_000_000), Ext: "ogg", Filename: "歌名 - 歌手.ogg"}, root)
	if err != nil {
		t.Fatalf("save downgrade candidate: %v", err)
	}
	if !result.Skipped {
		t.Fatal("a much smaller lossy variant must not replace a higher-bitrate mp3")
	}
	if _, statErr := os.Stat(oldMP3); statErr != nil {
		t.Fatalf("original high-bitrate mp3 must survive: %v", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(root, "歌名 - 歌手.ogg")); !os.IsNotExist(statErr) {
		t.Fatal("downgrade ogg must not be written")
	}
}

func TestLosslessAudioExtensionClassification(t *testing.T) {
	for _, ext := range []string{"flac", "wav", "alac", "ape", "FLAC", ".flac"} {
		if !isLosslessAudioExtension(ext) {
			t.Fatalf("%q should be lossless", ext)
		}
	}
	for _, ext := range []string{"mp3", "aac", "m4a", "ogg", ""} {
		if isLosslessAudioExtension(ext) {
			t.Fatalf("%q should not be lossless", ext)
		}
	}
}
